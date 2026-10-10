import { timingSafeEqual } from "node:crypto"
import { Cause, Effect, type ManagedRuntime, Option } from "effect"
import { Bot, type Context, InlineKeyboard } from "grammy"
import type { BotCommand } from "grammy/types"
import {
	addTask,
	approveReschedule,
	approveVacation,
	cancelReschedule,
	cancelVacation,
	canReschedule,
	complete,
	deleteTask,
	join,
	type Rejected,
	redeemToken,
	rejectReschedule,
	rejectVacation,
	requestReschedule,
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
	parseRescheduleArgs,
	parseVacation,
} from "../domain/commands.ts"
import { ParticipantId, type State } from "../domain/model.ts"
import { type Keyboard, MENU } from "../domain/outbox.ts"
import { findParticipant, findTask } from "../domain/schedule.ts"
import { HELP_TEXT } from "../domain/texts.ts"
import {
	annoyanceLevelPicker,
	annoyancePreviewView,
	annoyanceTaskPicker,
	deleteConfirm,
	deletePicker,
	doneConfirm,
	doneOtherPicker,
	donePicker,
	planView,
	rescheduleDatePicker,
	reschedulePicker,
	statsView,
	takeOverPicker,
	tasksView,
	todayView,
	tokenView,
	type View,
	vacationsView,
} from "../domain/views.ts"
import { readState, transact } from "../services/Household.ts"
import type { StateStore, StoreError } from "../services/StateStore.ts"
import { mainMenu, type Telegram } from "../services/Telegram.ts"

export type AppServices = StateStore | Telegram
export type AppRuntime = ManagedRuntime.ManagedRuntime<AppServices, unknown>

type Failure = Rejected | StoreError
type Handler = Effect.Effect<void, Failure, AppServices>

export const COMMANDS: ReadonlyArray<BotCommand> = [
	{ command: "heute", description: "Was heute ansteht" },
	{ command: "plan", description: "Die nächsten zwei Wochen" },
	{ command: "erledigt", description: "Aufgabe abhaken" },
	{ command: "verschieben", description: "Einen Termin einmalig verschieben" },
	{ command: "uebernehmen", description: "Freiwillig eine Aufgabe übernehmen" },
	{ command: "token", description: "Tokens ansehen und einlösen" },
	{ command: "urlaub", description: "Urlaub beantragen oder ansehen" },
	{ command: "punkte", description: "Statistik" },
	{ command: "aufgaben", description: "Alle Aufgaben" },
	{ command: "neu", description: "Neue Aufgabe: Name | Rhythmus | gemeinsam | ab Datum" },
	{ command: "rhythmus", description: "Rhythmus dauerhaft ändern: Nr | Rhythmus" },
	{ command: "termin", description: "Raster dauerhaft verlegen: Nr | Datum" },
	{ command: "nervig", description: "Nervigkeit einstellen, mit Vorschau" },
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

const replyWithMenu = (ctx: Context, text: string): Effect.Effect<void> =>
	telegramCall(() => ctx.reply(text, { ...HTML, reply_markup: mainMenu() }))

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

const NOT_A_MEMBER = "Du gehörst nicht zu diesem Haushalt. Ohne Einladungslink bleibt das so."

/** Loads the state and makes sure the sender belongs to the household. */
const memberView = (
	ctx: Context,
	render: (state: State, actor: ParticipantId, now: LocalMoment) => View,
): Handler =>
	Effect.gen(function* () {
		const { state, now } = yield* readState
		const actor = actorOf(ctx)
		if (Option.isNone(findParticipant(state, actor))) {
			return yield* reply(ctx, { text: NOT_A_MEMBER, keyboard: [] })
		}
		yield* reply(ctx, render(state, actor, now))
	})

/** Inline button action: on success show the toast, on refusal an alert. */
const runButton = (
	ctx: Context,
	apply: (state: State, now: LocalMoment) => Effect.Effect<Transition, Rejected>,
	after?: Handler,
): Handler =>
	Effect.gen(function* () {
		const transition = yield* transact(apply)
		yield* toast(ctx, transition.toast ?? "OK")
		if (after) {
			yield* after
		}
	})

/** Buttons that replace their message with another view (no state change). */
const showView = (
	ctx: Context,
	render: (state: State, actor: ParticipantId, now: LocalMoment) => View,
): Handler =>
	Effect.gen(function* () {
		const { state, now } = yield* readState
		const actor = actorOf(ctx)
		if (Option.isNone(findParticipant(state, actor))) {
			return yield* toast(ctx, NOT_A_MEMBER, true)
		}
		yield* toast(ctx, "")
		yield* editOrReply(ctx, render(state, actor, now))
	})

/** Like {@link showView}, for a specific task that may have disappeared in the meantime. */
const showTaskView = (
	ctx: Context,
	taskId: string,
	render: (state: State, actor: ParticipantId, now: LocalMoment) => Option.Option<View>,
): Handler =>
	Effect.gen(function* () {
		const { state, now } = yield* readState
		const actor = actorOf(ctx)
		if (Option.isNone(findParticipant(state, actor))) {
			return yield* toast(ctx, NOT_A_MEMBER, true)
		}
		if (Option.isNone(findTask(state, taskId))) {
			return yield* toast(ctx, "Diese Aufgabe gibt es nicht mehr.", true)
		}
		yield* Option.match(render(state, actor, now), {
			onNone: () => toast(ctx, "Das ist nicht mehr aktuell.", true),
			onSome: (v) => Effect.andThen(toast(ctx, ""), editOrReply(ctx, v)),
		})
	})

const handleCallback = (ctx: Context, action: CallbackAction): Handler => {
	const actor = actorOf(ctx)
	switch (action._tag) {
		case "Done":
			return runButton(ctx, (s, now) => complete(s, actor, action.taskId, action.index, now.date))
		case "DoneConfirm":
			return runButton(
				ctx,
				(s, now) => complete(s, actor, action.taskId, action.index, now.date),
				removeKeyboard(ctx),
			)
		case "DoneOther":
			return showView(ctx, (s, a, now) => doneOtherPicker(s, a, now.date))
		case "DoneAsk":
			return showTaskView(ctx, action.taskId, (s, a, now) =>
				Option.flatMap(findTask(s, action.taskId), (task) =>
					task.current.index === action.index
						? Option.some(doneConfirm(s, task, a, now.date))
						: Option.none(),
				),
			)
		case "TakeOver":
			return runButton(ctx, (s, now) => takeOver(s, actor, action.taskId, action.index, now.date))
		case "Token":
			return runButton(ctx, (s, now) => redeemToken(s, actor, action.taskId, action.index, now))
		case "RescheduleStart":
			return showTaskView(ctx, action.taskId, (s, a, now) =>
				Option.flatMap(findTask(s, action.taskId), (task) =>
					task.current.index === action.index && canReschedule(s, task, a)
						? Option.some(rescheduleDatePicker(s, task, now.date))
						: Option.none(),
				),
			)
		case "ReschedulePick":
			return runButton(
				ctx,
				(s, now) => requestReschedule(s, actor, action.taskId, action.index, action.date, now.date),
				removeKeyboard(ctx),
			)
		case "RescheduleApprove":
			return runButton(
				ctx,
				(s, now) => approveReschedule(s, actor, action.requestId, now.date),
				removeKeyboard(ctx),
			)
		case "RescheduleReject":
			return runButton(
				ctx,
				(s, now) => rejectReschedule(s, actor, action.requestId, now.date),
				removeKeyboard(ctx),
			)
		case "RescheduleCancel":
			return runButton(
				ctx,
				(s) => cancelReschedule(s, actor, action.requestId),
				removeKeyboard(ctx),
			)
		case "VacationApprove":
			return runButton(
				ctx,
				(s, now) => approveVacation(s, actor, action.vacationId, now.date),
				removeKeyboard(ctx),
			)
		case "VacationReject":
			return runButton(
				ctx,
				(s, now) => rejectVacation(s, actor, action.vacationId, now.date),
				removeKeyboard(ctx),
			)
		case "VacationCancel":
			return runButton(
				ctx,
				(s, now) => cancelVacation(s, actor, action.vacationId, now.date),
				removeKeyboard(ctx),
			)
		case "AnnoyancePick":
			return showTaskView(ctx, action.taskId, (s) =>
				Option.map(findTask(s, action.taskId), annoyanceLevelPicker),
			)
		case "AnnoyancePreview":
			return showTaskView(ctx, action.taskId, (s) =>
				Option.map(findTask(s, action.taskId), (task) => annoyancePreviewView(task)(action.level)),
			)
		case "AnnoyanceSave":
			return runButton(
				ctx,
				(s) => setAnnoyance(s, actor, action.taskId, action.level),
				removeKeyboard(ctx),
			)
		case "DeleteAsk":
			return showTaskView(ctx, action.taskId, (s) =>
				Option.map(findTask(s, action.taskId), deleteConfirm),
			)
		case "DeleteConfirm":
			return runButton(ctx, (s) => deleteTask(s, actor, action.taskId), removeKeyboard(ctx))
		case "Dismiss":
			return Effect.andThen(
				toast(ctx, "Abgebrochen."),
				telegramCall(() => ctx.deleteMessage()),
			)
	}
}

/** Turns a handler into grammY middleware: refusals become replies, everything else gets logged. */
const execute =
	(runtime: AppRuntime) =>
	(ctx: Context, handler: Handler): Promise<void> => {
		const isButton = ctx.callbackQuery !== undefined
		const failed = "Da ist technisch etwas schiefgelaufen. Nochmal versuchen hilft manchmal."
		const program = handler.pipe(
			Effect.catchTag("Rejected", (rejected) =>
				isButton
					? toast(ctx, rejected.reason, true)
					: reply(ctx, { text: rejected.reason, keyboard: [] }),
			),
			Effect.catchTag("StoreError", (error) =>
				Effect.andThen(
					Effect.logError("State store failure", Cause.fail(error.cause)),
					isButton ? toast(ctx, failed, true) : reply(ctx, { text: failed, keyboard: [] }),
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
			ctx.reply("Ich arbeite nur im Privatchat. Gruppen sind mir zu laut.").then(() => undefined),
		)
	const pm = safe.chatType("private")

	pm.command("start", (ctx) =>
		exec(
			ctx,
			Effect.gen(function* () {
				const { state } = yield* readState
				const member = { id: actorOf(ctx), name: ctx.from.first_name, chatId: ctx.chat.id }
				const known = Option.isSome(findParticipant(state, member.id))
				if (!(known || safeEquals(ctx.match.trim(), joinCode))) {
					return yield* reply(ctx, {
						text: "Das hier ist ein privater Haushalts-Bot. Ohne Einladungslink passiert hier nichts.",
						keyboard: [],
					})
				}
				yield* transact((s) => join(s, member))
			}),
		),
	)

	pm.command(["hilfe", "help", "menu"], (ctx) => exec(ctx, replyWithMenu(ctx, HELP_TEXT)))

	const today = (ctx: Context) =>
		exec(
			ctx,
			memberView(ctx, (s, actor, now) => todayView(s, actor, now.date)),
		)
	const plan = (ctx: Context) =>
		exec(
			ctx,
			memberView(ctx, (s, _, now) => planView(s, now.date)),
		)
	const done = (ctx: Context) =>
		exec(
			ctx,
			memberView(ctx, (s, actor, now) => donePicker(s, actor, now.date)),
		)
	const reschedule = (ctx: Context) =>
		exec(
			ctx,
			memberView(ctx, (s, actor, now) => reschedulePicker(s, actor, now.date)),
		)
	const takeOverMenu = (ctx: Context) =>
		exec(
			ctx,
			memberView(ctx, (s, actor, now) => takeOverPicker(s, actor, now.date)),
		)
	const tokens = (ctx: Context) =>
		exec(
			ctx,
			memberView(ctx, (s, actor, now) => tokenView(s, actor, now)),
		)

	// Persistent menu buttons send their label as plain text.
	pm.hears(MENU.today, today)
	pm.hears(MENU.plan, plan)
	pm.hears(MENU.done, done)
	pm.hears(MENU.reschedule, reschedule)
	pm.hears(MENU.takeOver, takeOverMenu)
	pm.hears(MENU.tokens, tokens)
	pm.hears("Joker", tokens) // label of the menu before the rename; stays on phones until resent

	pm.command("heute", today)
	pm.command("plan", plan)
	pm.command("erledigt", done)
	pm.command("uebernehmen", takeOverMenu)
	pm.command(["token", "tokens", "joker"], tokens)
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

	pm.command("verschieben", (ctx) => {
		if (ctx.match.trim() === "") {
			return reschedule(ctx)
		}
		const actor = actorOf(ctx)
		return exec(
			ctx,
			transact((s, now) =>
				Effect.flatMap(parseRescheduleArgs(s, ctx.match, now.date), ([task, date]) =>
					requestReschedule(s, actor, task.id, task.current.index, date, now.date),
				),
			),
		)
	})

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
				.answerCallbackQuery({ text: "Diesen Knopf kenne ich nicht mehr." })
				.then(() => undefined)
		}
		return exec(ctx, handleCallback(ctx, action.value))
	})

	pm.on("message", (ctx) =>
		exec(
			ctx,
			replyWithMenu(ctx, "Freitext verstehe ich nicht. Die Knöpfe unten schon, /hilfe auch."),
		),
	)

	return bot
}
