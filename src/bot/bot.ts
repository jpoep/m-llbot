import { timingSafeEqual } from "node:crypto"
import { Cause, Effect, type ManagedRuntime, Option } from "effect"
import { Bot, type Context, InlineKeyboard } from "grammy"
import type { BotCommand } from "grammy/types"
import {
	addTask,
	approveVacation,
	cancelVacation,
	complete,
	deleteTask,
	join,
	playJoker,
	type Rejected,
	rejectVacation,
	requestVacation,
	setAnnoyance,
	setCadence,
	setNextDate,
	type Transition,
	takeOver,
} from "../domain/actions.ts"
import { formatPreview } from "../domain/annoyance.ts"
import type { LocalMoment } from "../domain/calendar.ts"
import { type CallbackAction, decodeCallback } from "../domain/callbacks.ts"
import {
	parseCadenceChange,
	parseDateChange,
	parseLevel,
	parseNewTask,
	parseVacation,
} from "../domain/commands.ts"
import { ParticipantId, type State } from "../domain/model.ts"
import type { Keyboard } from "../domain/outbox.ts"
import { findParticipant, findTask } from "../domain/schedule.ts"
import { HELP_TEXT } from "../domain/texts.ts"
import {
	annoyanceLevelPicker,
	annoyancePreviewView,
	annoyanceTaskPicker,
	deleteConfirm,
	deletePicker,
	donePicker,
	jokerView,
	planView,
	statsView,
	takeOverPicker,
	tasksView,
	todayView,
	type View,
	vacationsView,
} from "../domain/views.ts"
import { readState, transact } from "../services/Household.ts"
import type { StateStore, StoreError } from "../services/StateStore.ts"
import type { Telegram } from "../services/Telegram.ts"

export type AppServices = StateStore | Telegram
export type AppRuntime = ManagedRuntime.ManagedRuntime<AppServices, unknown>

type Failure = Rejected | StoreError
type Handler = Effect.Effect<void, Failure, AppServices>

export const COMMANDS: ReadonlyArray<BotCommand> = [
	{ command: "heute", description: "Was heute ansteht" },
	{ command: "plan", description: "Die nächsten zwei Wochen" },
	{ command: "erledigt", description: "Aufgabe abhaken" },
	{ command: "uebernehmen", description: "Freiwillig eine Aufgabe übernehmen" },
	{ command: "joker", description: "Joker ansehen und einsetzen" },
	{ command: "urlaub", description: "Urlaub beantragen oder ansehen" },
	{ command: "punkte", description: "Statistik" },
	{ command: "aufgaben", description: "Alle Aufgaben" },
	{ command: "neu", description: "Neue Aufgabe: Name | Rhythmus | gemeinsam | ab Datum" },
	{ command: "rhythmus", description: "Rhythmus ändern: Nr | Rhythmus" },
	{ command: "termin", description: "Nächsten Termin verschieben: Nr | Datum" },
	{ command: "nervig", description: "Nervigkeit einstellen (mit Vorschau)" },
	{ command: "vorschau", description: "Vorschau einer Nervigkeitsstufe (0–10)" },
	{ command: "loeschen", description: "Aufgabe löschen" },
	{ command: "hilfe", description: "Alle Befehle und Regeln" },
]

const HTML = { parse_mode: "HTML", link_preview_options: { is_disabled: true } } as const

const markup = (keyboard: Keyboard) => ({
	reply_markup: InlineKeyboard.from(
		keyboard.map((row) => row.map((b) => InlineKeyboard.text(b.text, b.data))),
	),
})

const stripHtml = (text: string): string => text.replace(/<[^>]+>/g, "")

const safeEquals = (a: string, b: string): boolean => {
	const left = Buffer.from(a)
	const right = Buffer.from(b)
	return left.length === right.length && timingSafeEqual(left, right)
}

/** Telegram UI calls are best effort (e.g. "message is not modified" must not fail an action). */
const telegramCall = (call: () => Promise<unknown>): Effect.Effect<void> =>
	Effect.tryPromise(call).pipe(
		Effect.asVoid,
		Effect.catch((error) => Effect.logWarning("Telegram call failed", String(error))),
	)

const reply = (ctx: Context, view: View): Effect.Effect<void> =>
	telegramCall(() => ctx.reply(view.text, { ...HTML, ...markup(view.keyboard) }))

const editOrReply = (ctx: Context, view: View): Effect.Effect<void> =>
	telegramCall(() =>
		ctx.callbackQuery?.message
			? ctx.editMessageText(view.text, { ...HTML, ...markup(view.keyboard) })
			: ctx.reply(view.text, { ...HTML, ...markup(view.keyboard) }),
	)

const toast = (ctx: Context, text: string, alert = false): Effect.Effect<void> =>
	telegramCall(() =>
		ctx.answerCallbackQuery({ text: stripHtml(text).slice(0, 200), show_alert: alert }),
	)

const removeKeyboard = (ctx: Context): Effect.Effect<void> =>
	telegramCall(() => ctx.editMessageReplyMarkup())

const actorOf = (ctx: Context): ParticipantId => ParticipantId.make(ctx.from?.id ?? 0)

/** Loads the state and makes sure the sender belongs to the household. */
const memberView = (
	ctx: Context,
	render: (state: State, actor: ParticipantId, now: LocalMoment) => View,
): Handler =>
	Effect.gen(function* () {
		const { state, now } = yield* readState
		const actor = actorOf(ctx)
		if (Option.isNone(findParticipant(state, actor))) {
			return yield* reply(ctx, {
				text: "Du bist noch nicht dabei. Frag nach dem Einladungslink. 🔑",
				keyboard: [],
			})
		}
		yield* reply(ctx, render(state, actor, now))
	})

/** Inline button action: on success show the toast, on refusal an alert. */
const runButton = (
	ctx: Context,
	apply: (state: State, now: LocalMoment) => Effect.Effect<Transition, Rejected>,
	after?: (transition: Transition) => Handler,
): Handler =>
	Effect.gen(function* () {
		const transition = yield* transact(apply)
		yield* toast(ctx, transition.toast ?? "👍")
		if (after) {
			yield* after(transition)
		}
	})

const handleCallback = (ctx: Context, action: CallbackAction): Handler => {
	const actor = actorOf(ctx)
	switch (action._tag) {
		case "Done":
			return runButton(ctx, (s, now) => complete(s, actor, action.taskId, action.index, now.date))
		case "TakeOver":
			return runButton(ctx, (s, now) => takeOver(s, actor, action.taskId, action.index, now.date))
		case "Joker":
			return runButton(ctx, (s, now) => playJoker(s, actor, action.taskId, action.index, now))
		case "VacationApprove":
			return runButton(ctx, (s, now) => approveVacation(s, actor, action.vacationId, now.date))
		case "VacationReject":
			return runButton(ctx, (s, now) => rejectVacation(s, actor, action.vacationId, now.date))
		case "VacationCancel":
			return runButton(ctx, (s, now) => cancelVacation(s, actor, action.vacationId, now.date))
		case "AnnoyancePick":
		case "AnnoyancePreview":
		case "DeleteAsk":
			return Effect.gen(function* () {
				const { state } = yield* readState
				const task = findTask(state, action.taskId)
				if (Option.isNone(findParticipant(state, actor))) {
					return yield* toast(ctx, "Du bist noch nicht dabei.", true)
				}
				if (Option.isNone(task)) {
					return yield* toast(ctx, "Diese Aufgabe gibt es nicht mehr.", true)
				}
				yield* toast(ctx, "")
				if (action._tag === "AnnoyancePick") {
					return yield* editOrReply(ctx, annoyanceLevelPicker(task.value))
				}
				if (action._tag === "AnnoyancePreview") {
					return yield* editOrReply(ctx, annoyancePreviewView(task.value)(action.level))
				}
				return yield* editOrReply(ctx, deleteConfirm(task.value))
			})
		case "AnnoyanceSave":
			return runButton(
				ctx,
				(s) => setAnnoyance(s, actor, action.taskId, action.level),
				() => removeKeyboard(ctx),
			)
		case "DeleteConfirm":
			return runButton(
				ctx,
				(s) => deleteTask(s, actor, action.taskId),
				() => removeKeyboard(ctx),
			)
		case "Dismiss":
			return Effect.andThen(
				toast(ctx, "OK"),
				telegramCall(() => ctx.deleteMessage()),
			)
	}
}

/** Turns a handler into grammY middleware: refusals become replies, everything else gets logged. */
const execute =
	(runtime: AppRuntime) =>
	(ctx: Context, handler: Handler): Promise<void> => {
		const isButton = ctx.callbackQuery !== undefined
		const program = handler.pipe(
			Effect.catchTag("Rejected", (rejected) =>
				isButton
					? toast(ctx, rejected.reason, true)
					: reply(ctx, { text: `🙅 ${rejected.reason}`, keyboard: [] }),
			),
			Effect.catchTag("StoreError", (error) =>
				Effect.andThen(
					Effect.logError("State store failure", Cause.fail(error.cause)),
					isButton
						? toast(ctx, "Da ist technisch was schiefgelaufen. Versuch's nochmal.", true)
						: reply(ctx, {
								text: "💥 Da ist technisch was schiefgelaufen. Versuch's nochmal.",
								keyboard: [],
							}),
				),
			),
			Effect.catchCause((cause) => Effect.logError("Handler crashed", cause)),
			Effect.asVoid,
		)
		return runtime.runPromise(program)
	}

export interface BotOptions {
	readonly token: string
	readonly joinCode: string
	readonly runtime: AppRuntime
}

export const createBot = ({ token, joinCode, runtime }: BotOptions): Bot => {
	const bot = new Bot(token)
	const exec = execute(runtime)

	// Never let an error escape: in webhook mode Telegram would redeliver the update forever.
	const safe = bot.errorBoundary((error) => {
		console.error("Unhandled bot error", error.error)
	})

	safe
		.chatType(["group", "supergroup", "channel"])
		.use((ctx) =>
			ctx.reply("Ich arbeite nur im Privatchat. Schreib mir direkt. 🙂").then(() => undefined),
		)
	const pm = safe.chatType("private")

	pm.command("start", (ctx) =>
		exec(
			ctx,
			Effect.gen(function* () {
				const { state } = yield* readState
				const member = {
					id: actorOf(ctx),
					name: ctx.from.first_name,
					chatId: ctx.chat.id,
				}
				const known = Option.isSome(findParticipant(state, member.id))
				if (!(known || safeEquals(ctx.match.trim(), joinCode))) {
					return yield* reply(ctx, {
						text: "👋 Hi! Ich bin ein privater Haushalts-Bot. Ohne Einladungslink kann ich leider nichts für dich tun. 🔑",
						keyboard: [],
					})
				}
				yield* transact((s) => join(s, member))
			}),
		),
	)

	pm.command(["hilfe", "help"], (ctx) => ctx.reply(HELP_TEXT, HTML).then(() => undefined))
	pm.command("heute", (ctx) =>
		exec(
			ctx,
			memberView(ctx, (s, actor, now) => todayView(s, actor, now.date)),
		),
	)
	pm.command("plan", (ctx) =>
		exec(
			ctx,
			memberView(ctx, (s, _, now) => planView(s, now.date)),
		),
	)
	pm.command("aufgaben", (ctx) =>
		exec(
			ctx,
			memberView(ctx, (s, _, now) => tasksView(s, now.date)),
		),
	)
	pm.command("punkte", (ctx) =>
		exec(
			ctx,
			memberView(ctx, (s) => statsView(s)),
		),
	)
	pm.command("erledigt", (ctx) =>
		exec(
			ctx,
			memberView(ctx, (s, actor, now) => donePicker(s, actor, now.date)),
		),
	)
	pm.command("uebernehmen", (ctx) =>
		exec(
			ctx,
			memberView(ctx, (s, actor, now) => takeOverPicker(s, actor, now.date)),
		),
	)
	pm.command("joker", (ctx) =>
		exec(
			ctx,
			memberView(ctx, (s, actor, now) => jokerView(s, actor, now)),
		),
	)
	pm.command("nervig", (ctx) =>
		exec(
			ctx,
			memberView(ctx, (s) => annoyanceTaskPicker(s)),
		),
	)
	pm.command("loeschen", (ctx) =>
		exec(
			ctx,
			memberView(ctx, (s) => deletePicker(s)),
		),
	)

	pm.command("vorschau", (ctx) =>
		exec(
			ctx,
			Effect.flatMap(parseLevel(ctx.match), (level) =>
				reply(ctx, { text: formatPreview(level), keyboard: [] }),
			),
		),
	)

	pm.command("urlaub", (ctx) => {
		const actor = actorOf(ctx)
		if (ctx.match.trim() === "") {
			return exec(
				ctx,
				memberView(ctx, (s, a, now) => vacationsView(s, a, now.date)),
			)
		}
		return exec(
			ctx,
			transact((s, now) =>
				Effect.flatMap(parseVacation(ctx.match, now.date), ([from, to]) =>
					requestVacation(s, actor, from, to, now.date),
				),
			),
		)
	})

	pm.command("neu", (ctx) => {
		const actor = actorOf(ctx)
		return exec(
			ctx,
			transact((s, now) =>
				Effect.flatMap(parseNewTask(ctx.match, now.date), (spec) =>
					addTask(s, actor, spec, now.date),
				),
			),
		)
	})

	pm.command("rhythmus", (ctx) => {
		const actor = actorOf(ctx)
		return exec(
			ctx,
			transact((s) =>
				Effect.flatMap(parseCadenceChange(s, ctx.match), ([task, cadence]) =>
					setCadence(s, actor, task.id, cadence),
				),
			),
		)
	})

	pm.command("termin", (ctx) => {
		const actor = actorOf(ctx)
		return exec(
			ctx,
			transact((s, now) =>
				Effect.flatMap(parseDateChange(s, ctx.match, now.date), ([task, date]) =>
					setNextDate(s, actor, task.id, date, now.date),
				),
			),
		)
	})

	pm.on("callback_query:data", (ctx) => {
		const action = decodeCallback(ctx.callbackQuery.data)
		if (Option.isNone(action)) {
			return ctx
				.answerCallbackQuery({ text: "Diesen Knopf kenne ich nicht (mehr)." })
				.then(() => undefined)
		}
		return exec(ctx, handleCallback(ctx, action.value))
	})

	pm.on("message", (ctx) =>
		ctx.reply("Ich verstehe nur Befehle. /hilfe zeigt, welche. 🤖").then(() => undefined),
	)

	return bot
}
