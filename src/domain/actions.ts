import { Data, Effect, Option } from "effect"
import { settings } from "../settings.ts"
import { clampLevel, formatPreview } from "./annoyance.ts"
import { type Cadence, formatCadence, nthDate } from "./cadence.ts"
import {
	addDays,
	compareMoments,
	daysBetween,
	formatDate,
	formatMinute,
	formatRelativeDate,
	formatWhen,
	type LocalDate,
	type LocalMoment,
} from "./calendar.ts"
import { encodeCallback } from "./callbacks.ts"
import {
	emptyStats,
	type Occurrence,
	type Participant,
	type ParticipantId,
	type RescheduleRequest,
	type State,
	type Stats,
	type Task,
	type TaskKind,
	type Token,
	type Vacation,
} from "./model.ts"
import { column, type Outgoing, send, sendWithMenu } from "./outbox.ts"
import {
	findParticipant,
	findTask,
	isAvailable,
	participantName,
	projectTask,
	responsibleOn,
} from "./schedule.ts"
import { bold, escapeHtml, taskButtonLabel, taskLabel } from "./texts.ts"

/** A user-facing refusal. `reason` is shown to the user verbatim (German). */
export class Rejected extends Data.TaggedError("Rejected")<{ readonly reason: string }> {}

export interface Transition {
	readonly state: State
	readonly outbox: ReadonlyArray<Outgoing>
	/** Short confirmation shown as a toast when the action came from an inline button. */
	readonly toast?: string
}

const reject = (reason: string): Effect.Effect<never, Rejected> =>
	Effect.fail(new Rejected({ reason }))

// ---------------------------------------------------------------------------
// State helpers
// ---------------------------------------------------------------------------

export const replaceTask = (state: State, task: Task): State => ({
	...state,
	tasks: state.tasks.map((t) => (t.id === task.id ? task : t)),
})

export const updateStats = (
	state: State,
	id: ParticipantId,
	update: (stats: Stats) => Stats,
): State => ({
	...state,
	participants: state.participants.map((p) => (p.id === id ? { ...p, stats: update(p.stats) } : p)),
})

export const allocateId = (state: State, prefix: string): [id: string, state: State] => [
	`${prefix}${state.nextId}`,
	{ ...state, nextId: state.nextId + 1 },
]

const others = (state: State, id: ParticipantId): ReadonlyArray<Participant> =>
	state.participants.filter((p) => p.id !== id)

const notifyOthers = (state: State, actor: ParticipantId, text: string): ReadonlyArray<Outgoing> =>
	others(state, actor).map((p) => send(p.chatId, text))

const chatOf = (state: State, id: ParticipantId): ReadonlyArray<number> =>
	Option.match(findParticipant(state, id), { onNone: () => [], onSome: (p) => [p.chatId] })

const requireParticipant = (state: State, id: ParticipantId) =>
	Option.match(findParticipant(state, id), {
		onNone: () => reject("Du gehörst nicht zu diesem Haushalt. Ohne Einladungslink bleibt das so."),
		onSome: Effect.succeed,
	})

const requireTask = (state: State, taskId: string) =>
	Option.match(findTask(state, taskId), {
		onNone: () => reject("Diese Aufgabe gibt es nicht mehr."),
		onSome: Effect.succeed,
	})

/** Ensures a button press refers to the occurrence that is still pending. */
const requireCurrent = (state: State, taskId: string, index: number) =>
	Effect.flatMap(requireTask(state, taskId), (task) =>
		task.current.index === index
			? Effect.succeed(task)
			: reject("Das ist schon erledigt oder nicht mehr aktuell."),
	)

/** The date the current occurrence will actually happen (after vacation postponements). */
export const effectiveDueDate = (state: State, task: Task): LocalDate =>
	projectTask(state, task, "9999-12-31" as LocalDate)[0]?.date ?? task.current.dueDate

/** Whether `actor` is the one (or one of those) who has to do the task's current occurrence. */
export const isMine = (state: State, task: Task, actor: ParticipantId): boolean =>
	responsibleOn(state, task, effectiveDueDate(state, task)).includes(actor)

const freshOccurrence = (index: number, dueDate: LocalDate): Occurrence => ({
	index,
	dueDate,
	assignee: null,
	misses: 0,
	lastReminder: null,
})

const nextUp = (state: State, task: Task, today: LocalDate): string => {
	const next = projectTask(state, task, "9999-12-31" as LocalDate)[0]
	if (next === undefined) {
		return ""
	}
	const who =
		task.kind === "joint"
			? "alle"
			: next.responsible.map((id) => participantName(state, id)).join(", ")
	return `\nNächstes Mal: ${escapeHtml(who)}, ${formatRelativeDate(next.date, today)}.`
}

// ---------------------------------------------------------------------------
// Membership
// ---------------------------------------------------------------------------

export interface NewMember {
	readonly id: ParticipantId
	readonly name: string
	readonly chatId: number
}

export const join = (state: State, member: NewMember): Effect.Effect<Transition> => {
	if (findParticipant(state, member.id)._tag === "Some") {
		return Effect.succeed({
			state: {
				...state,
				participants: state.participants.map((p) =>
					p.id === member.id ? { ...p, name: member.name, chatId: member.chatId } : p,
				),
			},
			outbox: [
				sendWithMenu(
					member.chatId,
					"Du bist schon dabei. Mehrfach anmelden macht die Aufgaben auch nicht weniger.",
				),
			],
		})
	}
	const next: State = {
		...state,
		participants: [...state.participants, { ...member, stats: emptyStats }],
	}
	return Effect.succeed({
		state: next,
		outbox: [
			sendWithMenu(
				member.chatId,
				`Willkommen, ${bold(member.name)}. Ab jetzt erinnere ich dich an deine Aufgaben, abends gern auch öfter.\n\nDie Knöpfe unten decken das Übliche ab, /hilfe erklärt den Rest.`,
			),
			...notifyOthers(
				next,
				member.id,
				`${bold(member.name)} ist jetzt dabei. Die Aufgaben wurden neu verteilt, siehe /plan.`,
			),
		],
	})
}

// ---------------------------------------------------------------------------
// Completing, taking over, tokens
// ---------------------------------------------------------------------------

/** The next occurrence after completing the current one on `today`. */
export const nextAfterCompletion = (
	state: State,
	task: Task,
	today: LocalDate,
): {
	readonly anchor: LocalDate
	readonly occurrence: Occurrence
	readonly offSchedule: boolean
} => {
	if (today < effectiveDueDate(state, task)) {
		// Done ahead of time: the rhythm restarts from the day it was actually done.
		return {
			anchor: today,
			occurrence: freshOccurrence(1, nthDate(today, task.cadence, 1)),
			offSchedule: true,
		}
	}
	// On time or late (missed, rescheduled): stay on the grid, skipping dates that already passed.
	let nextIndex = task.current.index + 1
	while (nthDate(task.anchor, task.cadence, nextIndex) <= today) {
		nextIndex++
	}
	return {
		anchor: task.anchor,
		occurrence: freshOccurrence(nextIndex, nthDate(task.anchor, task.cadence, nextIndex)),
		offSchedule: false,
	}
}

/**
 * Ticks off the current occurrence. Anyone may do it: someone else's turn counts like a voluntary
 * take-over, and doing it early restarts the rhythm from today.
 */
export const complete = (
	state: State,
	actor: ParticipantId,
	taskId: string,
	index: number,
	today: LocalDate,
): Effect.Effect<Transition, Rejected> =>
	Effect.gen(function* () {
		const me = yield* requireParticipant(state, actor)
		const task = yield* requireCurrent(state, taskId, index)
		const due = effectiveDueDate(state, task)
		const wasResponsible = responsibleOn(state, task, due)
		const relieved = task.kind === "rotating" ? wasResponsible.filter((id) => id !== actor) : []

		const { anchor, occurrence, offSchedule } = nextAfterCompletion(state, task, today)
		const updated: Task = {
			...task,
			anchor,
			turn: task.kind === "rotating" ? task.turn + 1 : task.turn,
			current: occurrence,
		}
		const next = updateStats(
			{
				...replaceTask(state, updated),
				reschedules: state.reschedules.filter((r) => r.taskId !== taskId),
			},
			actor,
			(s) => ({ ...s, done: s.done + 1 }),
		)
		const upcoming = nextUp(next, updated, today)
		const early = offSchedule
			? ` Außer der Reihe, der Rhythmus zählt jetzt ab ${formatRelativeDate(today, today)}.`
			: ""
		const forEveryone = task.kind === "joint" ? ", damit ist es für alle abgehakt" : ""
		const message = (p: Participant): string =>
			relieved.includes(p.id)
				? `${bold(me.name)} hat ${taskLabel(task)} erledigt, obwohl du dran warst. Diesmal bist du raus.${early}${upcoming}`
				: `${bold(me.name)} hat ${taskLabel(task)} erledigt${forEveryone}.${early}${upcoming}`
		return {
			state: next,
			toast: "Erledigt.",
			outbox: [
				send(me.chatId, `Erledigt: ${taskLabel(task)}.${early}${upcoming}`),
				...others(next, actor).map((p) => send(p.chatId, message(p))),
			],
		}
	})

export const takeOver = (
	state: State,
	actor: ParticipantId,
	taskId: string,
	index: number,
	today: LocalDate,
): Effect.Effect<Transition, Rejected> =>
	Effect.gen(function* () {
		const me = yield* requireParticipant(state, actor)
		const task = yield* requireCurrent(state, taskId, index)
		if (task.kind === "joint") {
			return yield* reject("Gemeinsame Aufgaben macht ihr ohnehin zusammen.")
		}
		const due = effectiveDueDate(state, task)
		const previous = responsibleOn(state, task, due)
		if (previous.includes(actor)) {
			return yield* reject("Das ist bereits deine Aufgabe. Doppelt hält hier nicht besser.")
		}
		if (!isAvailable(state, actor, due)) {
			return yield* reject("An dem Tag bist du im Urlaub.")
		}
		const updated: Task = { ...task, current: { ...task.current, assignee: actor } }
		const next = updateStats(replaceTask(state, updated), actor, (s) => ({
			...s,
			takeovers: s.takeovers + 1,
		}))
		const when = formatRelativeDate(due, today)
		return {
			state: next,
			toast: "Übernommen.",
			outbox: [
				send(me.chatId, `Du übernimmst ${taskLabel(task)} (${when}). Freiwillig. Ist notiert.`),
				...previous.flatMap((id) =>
					chatOf(next, id).map((chatId) =>
						send(
							chatId,
							`${bold(me.name)} übernimmt ${taskLabel(task)} (${when}) für dich. Einfach so. Ein Dank wäre angebracht.`,
						),
					),
				),
			],
		}
	})

/** Tokens of `holder` for `task` whose debtor could actually take over on `date`. */
export const playableTokens = (
	state: State,
	holder: ParticipantId,
	task: Task,
	date: LocalDate,
): ReadonlyArray<Token> =>
	state.tokens.filter(
		(j) =>
			j.holder === holder &&
			j.taskId === task.id &&
			j.debtor !== holder &&
			isAvailable(state, j.debtor, date),
	)

export const tokenDeadline = (due: LocalDate): LocalMoment => ({
	date: due,
	minute: settings.tokenCutoffMinute,
})

export const canStillRedeemToken = (due: LocalDate, now: LocalMoment): boolean =>
	compareMoments(now, tokenDeadline(due)) < 0

export const redeemToken = (
	state: State,
	actor: ParticipantId,
	taskId: string,
	index: number,
	now: LocalMoment,
): Effect.Effect<Transition, Rejected> =>
	Effect.gen(function* () {
		const me = yield* requireParticipant(state, actor)
		const task = yield* requireCurrent(state, taskId, index)
		if (task.kind === "joint") {
			return yield* reject("Bei gemeinsamen Aufgaben gibt es keine Tokens.")
		}
		const due = effectiveDueDate(state, task)
		if (!responsibleOn(state, task, due).includes(actor)) {
			return yield* reject("Tokens gelten nur für deine eigenen Termine.")
		}
		if (!canStillRedeemToken(due, now)) {
			return yield* reject(
				`Zu spät. Tokens gehen nur bis ${formatMinute(settings.tokenCutoffMinute)} Uhr am Fälligkeitstag.`,
			)
		}
		const token = playableTokens(state, actor, task, due)[0]
		if (token === undefined) {
			return yield* reject("Du hast kein einlösbares Token für diese Aufgabe.")
		}
		const updated: Task = { ...task, current: { ...task.current, assignee: token.debtor } }
		const next = updateStats(
			{ ...replaceTask(state, updated), tokens: state.tokens.filter((j) => j.id !== token.id) },
			actor,
			(s) => ({ ...s, tokensPlayed: s.tokensPlayed + 1 }),
		)
		const when = formatRelativeDate(due, now.date)
		const debtorName = participantName(state, token.debtor)
		return {
			state: next,
			toast: "Token eingelöst.",
			outbox: [
				send(
					me.chatId,
					`Token eingelöst. ${bold(debtorName)} übernimmt ${taskLabel(task)} (${when}).`,
				),
				...chatOf(next, token.debtor).map((chatId) =>
					send(
						chatId,
						`${bold(me.name)} hat ein Token eingelöst. Du übernimmst ${taskLabel(task)} (${when}).\nDas ist die Rechnung für den ${formatDate(token.earnedOn)}.`,
					),
				),
			],
		}
	})

// ---------------------------------------------------------------------------
// One-off reschedule (needs someone else's approval)
// ---------------------------------------------------------------------------

const requireReschedule = (state: State, requestId: string) =>
	Option.match(Option.fromUndefinedOr(state.reschedules.find((r) => r.id === requestId)), {
		onNone: () => reject("Diese Anfrage gibt es nicht mehr."),
		onSome: Effect.succeed,
	})

const withoutRequest = (state: State, requestId: string): State => ({
	...state,
	reschedules: state.reschedules.filter((r) => r.id !== requestId),
})

/** Whether `actor` may ask to move the task's current occurrence. */
export const canReschedule = (state: State, task: Task, actor: ParticipantId): boolean =>
	task.kind === "joint"
		? state.participants.some((p) => p.id === actor)
		: isMine(state, task, actor)

export const requestReschedule = (
	state: State,
	actor: ParticipantId,
	taskId: string,
	index: number,
	to: LocalDate,
	today: LocalDate,
): Effect.Effect<Transition, Rejected> =>
	Effect.gen(function* () {
		const me = yield* requireParticipant(state, actor)
		const task = yield* requireCurrent(state, taskId, index)
		if (!canReschedule(state, task, actor)) {
			return yield* reject("Verschieben kann nur, wer dran ist.")
		}
		const from = effectiveDueDate(state, task)
		if (to < today) {
			return yield* reject("Der neue Termin liegt in der Vergangenheit.")
		}
		if (to === from) {
			return yield* reject("Das ist bereits der Termin.")
		}
		if (daysBetween(today, to) > settings.maxRescheduleDays) {
			return yield* reject(
				`Höchstens ${settings.maxRescheduleDays} Tage im Voraus. Alles darüber ist kein Verschieben mehr, sondern Verdrängen.`,
			)
		}
		if (others(state, actor).length === 0) {
			return yield* reject("Es gibt niemanden, der das genehmigen könnte.")
		}
		if (state.reschedules.some((r) => r.taskId === taskId && r.index === index)) {
			return yield* reject("Für diesen Termin läuft schon eine Anfrage.")
		}
		const [id, withId] = allocateId(state, "r")
		const request: RescheduleRequest = { id, taskId, index, requester: actor, from, to }
		const next: State = { ...withId, reschedules: [...withId.reschedules, request] }
		const move = `von ${formatRelativeDate(from, today)} auf ${formatRelativeDate(to, today)}`
		return {
			state: next,
			toast: "Anfrage gestellt.",
			outbox: [
				send(
					me.chatId,
					`Anfrage gestellt: ${taskLabel(task)} ${move}. Jetzt muss jemand zustimmen.`,
					column([
						{
							text: "Anfrage zurückziehen",
							data: encodeCallback({ _tag: "RescheduleCancel", requestId: id }),
						},
					]),
				),
				...others(next, actor).map((p) =>
					send(p.chatId, `${bold(me.name)} möchte ${taskLabel(task)} ${move} verschieben.`, [
						[
							{
								text: "Genehmigen",
								data: encodeCallback({ _tag: "RescheduleApprove", requestId: id }),
							},
							{
								text: "Ablehnen",
								data: encodeCallback({ _tag: "RescheduleReject", requestId: id }),
							},
						],
					]),
				),
			],
		}
	})

export const approveReschedule = (
	state: State,
	actor: ParticipantId,
	requestId: string,
	today: LocalDate,
): Effect.Effect<Transition, Rejected> =>
	Effect.gen(function* () {
		const me = yield* requireParticipant(state, actor)
		const request = yield* requireReschedule(state, requestId)
		if (request.requester === actor) {
			return yield* reject("Die eigene Anfrage genehmigen klappt leider nicht.")
		}
		const task = Option.getOrUndefined(findTask(state, request.taskId))
		if (task === undefined || task.current.index !== request.index || request.to < today) {
			// Stale requests are cleaned up by the midnight rollover.
			return yield* reject("Die Anfrage ist nicht mehr aktuell.")
		}
		const updated: Task = {
			...task,
			current: { ...task.current, dueDate: request.to, lastReminder: null },
		}
		const next = withoutRequest(replaceTask(state, updated), requestId)
		const when = formatWhen(request.to, today)
		return {
			state: next,
			toast: "Genehmigt.",
			outbox: [
				send(me.chatId, `Genehmigt. ${taskLabel(task)} ist jetzt ${when} fällig.`),
				...chatOf(next, request.requester).map((chatId) =>
					send(
						chatId,
						`${bold(me.name)} hat zugestimmt. ${taskLabel(task)} ist jetzt ${when} fällig.`,
					),
				),
			],
		}
	})

export const rejectReschedule = (
	state: State,
	actor: ParticipantId,
	requestId: string,
	today: LocalDate,
): Effect.Effect<Transition, Rejected> =>
	Effect.gen(function* () {
		const me = yield* requireParticipant(state, actor)
		const request = yield* requireReschedule(state, requestId)
		if (request.requester === actor) {
			return yield* reject("Zum Zurückziehen bitte „Anfrage zurückziehen“ nehmen.")
		}
		const name = Option.match(findTask(state, request.taskId), {
			onNone: () => "die Aufgabe",
			onSome: taskLabel,
		})
		const next = withoutRequest(state, requestId)
		return {
			state: next,
			toast: "Abgelehnt.",
			outbox: [
				send(
					me.chatId,
					`Abgelehnt. ${name} bleibt ${formatRelativeDate(request.from, today)} fällig.`,
				),
				...chatOf(next, request.requester).map((chatId) =>
					send(
						chatId,
						`${bold(me.name)} hat abgelehnt. ${name} bleibt ${formatRelativeDate(request.from, today)} fällig.`,
					),
				),
			],
		}
	})

export const cancelReschedule = (
	state: State,
	actor: ParticipantId,
	requestId: string,
): Effect.Effect<Transition, Rejected> =>
	Effect.gen(function* () {
		const me = yield* requireParticipant(state, actor)
		const request = yield* requireReschedule(state, requestId)
		if (request.requester !== actor) {
			return yield* reject("Nur wer gefragt hat, kann die Anfrage zurückziehen.")
		}
		const name = Option.match(findTask(state, request.taskId), {
			onNone: () => "die Aufgabe",
			onSome: taskLabel,
		})
		const next = withoutRequest(state, requestId)
		return {
			state: next,
			toast: "Zurückgezogen.",
			outbox: [
				send(me.chatId, `Anfrage zurückgezogen. ${name} bleibt, wo es war.`),
				...notifyOthers(next, actor, `${bold(me.name)} hat die Anfrage zu ${name} zurückgezogen.`),
			],
		}
	})

/** The dates offered when picking a new date: the next days, minus the current due date. */
export const rescheduleOptions = (
	state: State,
	task: Task,
	today: LocalDate,
): ReadonlyArray<LocalDate> => {
	const due = effectiveDueDate(state, task)
	return Array.from({ length: settings.maxRescheduleDays + 1 }, (_, i) => addDays(today, i))
		.filter((d) => d !== due)
		.slice(0, 9)
}

// ---------------------------------------------------------------------------
// Vacation
// ---------------------------------------------------------------------------

const requireVacation = (state: State, vacationId: string) =>
	Option.match(Option.fromUndefinedOr(state.vacations.find((v) => v.id === vacationId)), {
		onNone: () => reject("Diesen Urlaubsantrag gibt es nicht mehr."),
		onSome: Effect.succeed,
	})

export const vacationRange = (v: Vacation, today: LocalDate): string =>
	`${formatDate(v.from, today)} – ${formatDate(v.to, today)}`

export const requestVacation = (
	state: State,
	actor: ParticipantId,
	from: LocalDate,
	to: LocalDate,
	today: LocalDate,
): Effect.Effect<Transition, Rejected> =>
	Effect.gen(function* () {
		const me = yield* requireParticipant(state, actor)
		if (from < today) {
			return yield* reject("Urlaub in der Vergangenheit lässt sich leider nicht mehr beantragen.")
		}
		if (to < from) {
			return yield* reject("Das Ende liegt vor dem Anfang. Das wird schwierig.")
		}
		if (daysBetween(from, to) + 1 > settings.maxVacationDays) {
			return yield* reject(`Höchstens ${settings.maxVacationDays} Tage am Stück.`)
		}
		if (others(state, actor).length === 0) {
			return yield* reject("Es gibt niemanden, der den Urlaub genehmigen könnte.")
		}
		const overlapping = state.vacations.some(
			(v) => v.participant === actor && v.from <= to && from <= v.to,
		)
		if (overlapping) {
			return yield* reject("Da gibt es schon einen Urlaub oder Antrag, der sich überschneidet.")
		}
		const [id, withId] = allocateId(state, "v")
		const vacation: Vacation = { id, participant: actor, from, to, status: "pending" }
		const next: State = { ...withId, vacations: [...withId.vacations, vacation] }
		const range = vacationRange(vacation, today)
		return {
			state: next,
			outbox: [
				send(
					me.chatId,
					`Urlaubsantrag für ${range} gestellt. Jetzt muss jemand zustimmen.`,
					column([
						{
							text: "Antrag zurückziehen",
							data: encodeCallback({ _tag: "VacationCancel", vacationId: id }),
						},
					]),
				),
				...others(next, actor).map((p) =>
					send(
						p.chatId,
						`${bold(me.name)} möchte Urlaub: ${range}. In der Zeit fallen die Aufgaben an dich, ohne Tokens.`,
						[
							[
								{
									text: "Genehmigen",
									data: encodeCallback({ _tag: "VacationApprove", vacationId: id }),
								},
								{
									text: "Ablehnen",
									data: encodeCallback({ _tag: "VacationReject", vacationId: id }),
								},
							],
						],
					),
				),
			],
		}
	})

export const approveVacation = (
	state: State,
	actor: ParticipantId,
	vacationId: string,
	today: LocalDate,
): Effect.Effect<Transition, Rejected> =>
	Effect.gen(function* () {
		const me = yield* requireParticipant(state, actor)
		const vacation = yield* requireVacation(state, vacationId)
		if (vacation.participant === actor) {
			return yield* reject("Den eigenen Urlaub genehmigen ist ein interessanter Ansatz. Nein.")
		}
		if (vacation.status === "approved") {
			return yield* reject("Ist schon genehmigt.")
		}
		const next: State = {
			...state,
			vacations: state.vacations.map((v) =>
				v.id === vacationId ? { ...v, status: "approved" as const } : v,
			),
		}
		const range = vacationRange(vacation, today)
		return {
			state: next,
			toast: "Genehmigt.",
			outbox: [
				send(
					me.chatId,
					`Urlaub von ${bold(participantName(state, vacation.participant))} (${range}) genehmigt.`,
				),
				...chatOf(next, vacation.participant).map((chatId) =>
					send(
						chatId,
						`${bold(me.name)} hat deinen Urlaub (${range}) genehmigt. Erhol dich.`,
						column([
							{
								text: "Urlaub absagen",
								data: encodeCallback({ _tag: "VacationCancel", vacationId }),
							},
						]),
					),
				),
			],
		}
	})

export const rejectVacation = (
	state: State,
	actor: ParticipantId,
	vacationId: string,
	today: LocalDate,
): Effect.Effect<Transition, Rejected> =>
	Effect.gen(function* () {
		const me = yield* requireParticipant(state, actor)
		const vacation = yield* requireVacation(state, vacationId)
		if (vacation.participant === actor) {
			return yield* reject("Zum Zurückziehen bitte „Antrag zurückziehen“ nehmen.")
		}
		if (vacation.status === "approved") {
			return yield* reject(
				"Der Urlaub ist schon genehmigt. Absagen kann ihn nur, wer ihn beantragt hat.",
			)
		}
		const next: State = { ...state, vacations: state.vacations.filter((v) => v.id !== vacationId) }
		const range = vacationRange(vacation, today)
		return {
			state: next,
			toast: "Abgelehnt.",
			outbox: [
				send(me.chatId, `Urlaubsantrag (${range}) abgelehnt.`),
				...chatOf(next, vacation.participant).map((chatId) =>
					send(chatId, `${bold(me.name)} hat deinen Urlaubsantrag (${range}) abgelehnt.`),
				),
			],
		}
	})

export const cancelVacation = (
	state: State,
	actor: ParticipantId,
	vacationId: string,
	today: LocalDate,
): Effect.Effect<Transition, Rejected> =>
	Effect.gen(function* () {
		const me = yield* requireParticipant(state, actor)
		const vacation = yield* requireVacation(state, vacationId)
		if (vacation.participant !== actor) {
			return yield* reject("Nur wer den Urlaub beantragt hat, kann ihn absagen.")
		}
		const next: State = { ...state, vacations: state.vacations.filter((v) => v.id !== vacationId) }
		const range = vacationRange(vacation, today)
		const what = vacation.status === "approved" ? "Urlaub" : "Urlaubsantrag"
		return {
			state: next,
			toast: "Abgesagt.",
			outbox: [
				send(me.chatId, `${what} (${range}) abgesagt. Deine Aufgaben sind wieder deine.`),
				...notifyOthers(next, actor, `${bold(me.name)} hat den ${what} (${range}) abgesagt.`),
			],
		}
	})

// ---------------------------------------------------------------------------
// Task administration
// ---------------------------------------------------------------------------

export interface NewTask {
	readonly name: string
	readonly cadence: Cadence
	readonly kind: TaskKind
	readonly firstDue: LocalDate
	readonly annoyance: number
}

export const createTask = (state: State, spec: NewTask): [Task, State] => {
	const [id, withId] = allocateId(state, "t")
	const task: Task = {
		id,
		name: spec.name,
		kind: spec.kind,
		cadence: spec.cadence,
		annoyance: clampLevel(spec.annoyance),
		anchor: spec.firstDue,
		rotationOffset: state.tasks.length,
		turn: 0,
		current: freshOccurrence(0, spec.firstDue),
	}
	return [task, { ...withId, tasks: [...withId.tasks, task] }]
}

export const addTask = (
	state: State,
	actor: ParticipantId,
	spec: NewTask,
	today: LocalDate,
): Effect.Effect<Transition, Rejected> =>
	Effect.gen(function* () {
		const me = yield* requireParticipant(state, actor)
		const name = spec.name.trim()
		if (name.length === 0 || name.length > 60) {
			return yield* reject("Der Name muss zwischen 1 und 60 Zeichen lang sein.")
		}
		if (state.tasks.some((t) => t.name.toLowerCase() === name.toLowerCase())) {
			return yield* reject("Eine Aufgabe mit dem Namen gibt es schon.")
		}
		if (spec.firstDue < today) {
			return yield* reject(
				"Der erste Termin liegt in der Vergangenheit. Der wäre dann schon verpasst.",
			)
		}
		const [task, next] = createTask(state, { ...spec, name })
		const text = `${taskLabel(task)}, ${formatCadence(task.cadence)}${task.kind === "joint" ? ", gemeinsam" : ""}, zum ersten Mal ${formatRelativeDate(task.anchor, today)}.`
		return {
			state: next,
			outbox: [
				send(
					me.chatId,
					`Neue Aufgabe: ${text}\nNervigkeit ${task.annoyance}/10, einstellbar mit /nervig.`,
				),
				...notifyOthers(next, actor, `${bold(me.name)} hat eine neue Aufgabe angelegt: ${text}`),
			],
		}
	})

export const deleteTask = (
	state: State,
	actor: ParticipantId,
	taskId: string,
): Effect.Effect<Transition, Rejected> =>
	Effect.gen(function* () {
		const me = yield* requireParticipant(state, actor)
		const task = yield* requireTask(state, taskId)
		const next: State = {
			...state,
			tasks: state.tasks.filter((t) => t.id !== taskId),
			tokens: state.tokens.filter((j) => j.taskId !== taskId),
			reschedules: state.reschedules.filter((r) => r.taskId !== taskId),
		}
		return {
			state: next,
			toast: "Gelöscht.",
			outbox: [
				send(me.chatId, `${taskLabel(task)} gelöscht.`),
				...notifyOthers(next, actor, `${bold(me.name)} hat ${taskLabel(task)} gelöscht.`),
			],
		}
	})

export const setAnnoyance = (
	state: State,
	actor: ParticipantId,
	taskId: string,
	level: number,
): Effect.Effect<Transition, Rejected> =>
	Effect.gen(function* () {
		const me = yield* requireParticipant(state, actor)
		const task = yield* requireTask(state, taskId)
		const annoyance = clampLevel(level)
		const next = replaceTask(state, { ...task, annoyance })
		const remark = annoyance < task.annoyance ? " Nach unten. Interessant." : ""
		return {
			state: next,
			toast: `Nervigkeit ${annoyance}/10 gespeichert.`,
			outbox: [
				send(
					me.chatId,
					`${taskLabel(task)}: Nervigkeit ${task.annoyance} → ${annoyance}.\n\n${formatPreview(annoyance)}`,
				),
				...notifyOthers(
					next,
					actor,
					`${bold(me.name)} hat die Nervigkeit von ${taskLabel(task)} von ${task.annoyance} auf ${annoyance} gestellt.${remark}`,
				),
			],
		}
	})

export const setCadence = (
	state: State,
	actor: ParticipantId,
	taskId: string,
	cadence: Cadence,
): Effect.Effect<Transition, Rejected> =>
	Effect.gen(function* () {
		const me = yield* requireParticipant(state, actor)
		const task = yield* requireTask(state, taskId)
		// Re-anchor the grid on the pending occurrence so its date stays put.
		const next: State = {
			...replaceTask(state, {
				...task,
				cadence,
				anchor: task.current.dueDate,
				current: { ...task.current, index: 0 },
			}),
			reschedules: state.reschedules.filter((r) => r.taskId !== taskId),
		}
		const text = `${taskLabel(task)}: ${formatCadence(task.cadence)} → ${formatCadence(cadence)}.`
		return {
			state: next,
			outbox: [send(me.chatId, text), ...notifyOthers(next, actor, `${bold(me.name)}: ${text}`)],
		}
	})

export const setNextDate = (
	state: State,
	actor: ParticipantId,
	taskId: string,
	date: LocalDate,
	today: LocalDate,
): Effect.Effect<Transition, Rejected> =>
	Effect.gen(function* () {
		const me = yield* requireParticipant(state, actor)
		const task = yield* requireTask(state, taskId)
		if (date < today) {
			return yield* reject("Der Termin liegt in der Vergangenheit.")
		}
		const next: State = {
			...replaceTask(state, {
				...task,
				anchor: date,
				current: { ...task.current, index: 0, dueDate: date, misses: 0, lastReminder: null },
			}),
			reschedules: state.reschedules.filter((r) => r.taskId !== taskId),
		}
		const text = `${taskLabel(task)} ist jetzt ${formatWhen(date, today)} fällig, und von da an im gewohnten Rhythmus.`
		return {
			state: next,
			outbox: [send(me.chatId, text), ...notifyOthers(next, actor, `${bold(me.name)}: ${text}`)],
		}
	})

export const taskButtons = (
	tasks: ReadonlyArray<Task>,
	toData: (task: Task) => string,
): ReturnType<typeof column> =>
	column(tasks.map((task) => ({ text: taskButtonLabel(task), data: toData(task) })))
