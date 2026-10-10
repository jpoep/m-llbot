import { Data, Effect, Option } from "effect"
import { settings } from "../settings.ts"
import { clampLevel, formatPreview } from "./annoyance.ts"
import { type Cadence, formatCadence, nthDate } from "./cadence.ts"
import {
	compareMoments,
	daysBetween,
	formatDate,
	formatMinute,
	formatRelativeDate,
	type LocalDate,
	type LocalMoment,
} from "./calendar.ts"
import { encodeCallback } from "./callbacks.ts"
import {
	emptyStats,
	type Joker,
	type Occurrence,
	type Participant,
	type ParticipantId,
	type State,
	type Stats,
	type Task,
	type TaskKind,
	type Vacation,
} from "./model.ts"
import { column, type Outgoing, send } from "./outbox.ts"
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
		onNone: () => reject("Du bist noch nicht dabei. Frag nach dem Einladungslink."),
		onSome: Effect.succeed,
	})

const requireTask = (state: State, taskId: string) =>
	Option.match(findTask(state, taskId), {
		onNone: () => reject("Diese Aufgabe gibt es nicht (mehr)."),
		onSome: Effect.succeed,
	})

/** Ensures a button press refers to the occurrence that is still pending. */
const requireCurrent = (state: State, taskId: string, index: number) =>
	Effect.flatMap(requireTask(state, taskId), (task) =>
		task.current.index === index
			? Effect.succeed(task)
			: reject("Das ist schon erledigt oder nicht mehr aktuell. ✅"),
	)

/** The date the current occurrence will actually happen (after vacation postponements). */
export const effectiveDueDate = (state: State, task: Task): LocalDate =>
	projectTask(state, task, "9999-12-31" as LocalDate)[0]?.date ?? task.current.dueDate

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
	return `\nAls Nächstes: ${escapeHtml(who)}, ${formatRelativeDate(next.date, today)}.`
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
			outbox: [send(member.chatId, "Du bist schon dabei. 🙂 /hilfe zeigt alle Befehle.")],
		})
	}
	const next: State = {
		...state,
		participants: [...state.participants, { ...member, stats: emptyStats }],
	}
	return Effect.succeed({
		state: next,
		outbox: [
			send(
				member.chatId,
				`Willkommen im Haushalt, ${bold(member.name)}! 🧹\n\nAb jetzt nerve ich dich zuverlässig. /plan zeigt, was ansteht, /hilfe erklärt den Rest.`,
			),
			...notifyOthers(
				next,
				member.id,
				`👋 ${bold(member.name)} ist jetzt dabei. Die Rotation wurde neu verteilt – schau mal in /plan.`,
			),
		],
	})
}

// ---------------------------------------------------------------------------
// Completing, taking over, jokers
// ---------------------------------------------------------------------------

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
		if (task.kind === "rotating" && !responsibleOn(state, task, due).includes(actor)) {
			return yield* reject(
				"Das ist gerade nicht deine Aufgabe. Wenn du sie machen willst: /uebernehmen 🦸",
			)
		}

		let nextIndex = task.current.index + 1
		while (nthDate(task.anchor, task.cadence, nextIndex) <= today) {
			nextIndex++
		}
		const updated: Task = {
			...task,
			turn: task.kind === "rotating" ? task.turn + 1 : task.turn,
			current: freshOccurrence(nextIndex, nthDate(task.anchor, task.cadence, nextIndex)),
		}
		const next = updateStats(replaceTask(state, updated), actor, (s) => ({
			...s,
			done: s.done + 1,
		}))
		const early = daysBetween(today, due) > 0 ? " (sogar früher als nötig 👏)" : ""
		const forEveryone = task.kind === "joint" ? " – für alle abgehakt" : ""
		return {
			state: next,
			toast: "✅ Erledigt!",
			outbox: [
				send(me.chatId, `✅ ${taskLabel(task)} erledigt${early}.${nextUp(next, updated, today)}`),
				...notifyOthers(
					next,
					actor,
					`✅ ${bold(me.name)} hat ${taskLabel(task)} erledigt${forEveryone}.${nextUp(next, updated, today)}`,
				),
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
			return yield* reject("Gemeinsame Aufgaben macht ihr eh zusammen. 👫")
		}
		const due = effectiveDueDate(state, task)
		const previous = responsibleOn(state, task, due)
		if (previous.includes(actor)) {
			return yield* reject("Das ist doch sowieso deine Aufgabe. 😄")
		}
		if (!isAvailable(state, actor, due)) {
			return yield* reject("An dem Tag bist du im Urlaub. 🏖️")
		}
		const updated: Task = { ...task, current: { ...task.current, assignee: actor } }
		const next = updateStats(replaceTask(state, updated), actor, (s) => ({
			...s,
			takeovers: s.takeovers + 1,
		}))
		const when = formatRelativeDate(due, today)
		return {
			state: next,
			toast: "🦸 Übernommen!",
			outbox: [
				send(me.chatId, `🦸 Du übernimmst ${taskLabel(task)} (${when}). Ehrenhaft!`),
				...previous.flatMap((id) =>
					chatOf(next, id).map((chatId) =>
						send(
							chatId,
							`🦸 ${bold(me.name)} übernimmt ${taskLabel(task)} (${when}) für dich. Einfach so. Bedank dich mal.`,
						),
					),
				),
			],
		}
	})

/** Jokers of `holder` for `task` whose debtor could actually take over on `date`. */
export const playableJokers = (
	state: State,
	holder: ParticipantId,
	task: Task,
	date: LocalDate,
): ReadonlyArray<Joker> =>
	state.jokers.filter(
		(j) =>
			j.holder === holder &&
			j.taskId === task.id &&
			j.debtor !== holder &&
			isAvailable(state, j.debtor, date),
	)

export const jokerDeadline = (due: LocalDate): LocalMoment => ({
	date: due,
	minute: settings.jokerCutoffMinute,
})

export const canStillPlayJoker = (due: LocalDate, now: LocalMoment): boolean =>
	compareMoments(now, jokerDeadline(due)) < 0

export const playJoker = (
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
			return yield* reject("Bei gemeinsamen Aufgaben gibt's keine Joker. 👫")
		}
		const due = effectiveDueDate(state, task)
		if (!responsibleOn(state, task, due).includes(actor)) {
			return yield* reject("Joker kannst du nur für deine eigenen Termine einsetzen.")
		}
		if (!canStillPlayJoker(due, now)) {
			return yield* reject(
				`Zu spät! Joker gehen nur bis ${formatMinute(settings.jokerCutoffMinute)} Uhr am Fälligkeitstag. ⏰`,
			)
		}
		const joker = playableJokers(state, actor, task, due)[0]
		if (joker === undefined) {
			return yield* reject("Du hast keinen einsetzbaren Joker für diese Aufgabe. 🃏")
		}
		const updated: Task = { ...task, current: { ...task.current, assignee: joker.debtor } }
		const next = updateStats(
			{ ...replaceTask(state, updated), jokers: state.jokers.filter((j) => j.id !== joker.id) },
			actor,
			(s) => ({ ...s, jokersPlayed: s.jokersPlayed + 1 }),
		)
		const when = formatRelativeDate(due, now.date)
		const debtorName = participantName(state, joker.debtor)
		return {
			state: next,
			toast: "🃏 Joker gespielt!",
			outbox: [
				send(
					me.chatId,
					`🃏 Joker gespielt! ${bold(debtorName)} macht ${taskLabel(task)} (${when}) für dich. Genieß es.`,
				),
				...chatOf(next, joker.debtor).map((chatId) =>
					send(
						chatId,
						`🃏 ${bold(me.name)} spielt einen Joker aus! Du machst ${taskLabel(task)} (${when}).\nDen hast du dir am ${formatDate(joker.earnedOn)} selbst eingebrockt. 😈`,
					),
				),
			],
		}
	})

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
			return yield* reject("Urlaub in der Vergangenheit? Netter Versuch. 🙃")
		}
		if (to < from) {
			return yield* reject("Das Ende liegt vor dem Anfang. 🤔")
		}
		if (daysBetween(from, to) + 1 > settings.maxVacationDays) {
			return yield* reject(`Maximal ${settings.maxVacationDays} Tage am Stück.`)
		}
		if (others(state, actor).length === 0) {
			return yield* reject("Es gibt niemanden, der deinen Urlaub genehmigen könnte.")
		}
		const overlapping = state.vacations.some(
			(v) => v.participant === actor && v.from <= to && from <= v.to,
		)
		if (overlapping) {
			return yield* reject("Da hast du schon einen Urlaub (oder Antrag), der sich überschneidet.")
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
					`🏖️ Urlaubsantrag für ${range} gestellt. Jetzt muss jemand zustimmen.`,
					column([
						{
							text: "❌ Antrag zurückziehen",
							data: encodeCallback({ _tag: "VacationCancel", vacationId: id }),
						},
					]),
				),
				...others(next, actor).map((p) =>
					send(
						p.chatId,
						`🏖️ ${bold(me.name)} möchte Urlaub: ${range}.\nIn der Zeit übernimmst du die Aufgaben – ohne Joker.`,
						[
							[
								{
									text: "✅ Genehmigen",
									data: encodeCallback({ _tag: "VacationApprove", vacationId: id }),
								},
								{
									text: "❌ Ablehnen",
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
			return yield* reject("Den eigenen Urlaub genehmigen? So läuft das nicht. 😏")
		}
		if (vacation.status === "approved") {
			return yield* reject("Ist schon genehmigt. 👍")
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
			toast: "✅ Genehmigt",
			outbox: [
				send(
					me.chatId,
					`✅ Urlaub von ${bold(participantName(state, vacation.participant))} (${range}) genehmigt.`,
				),
				...chatOf(next, vacation.participant).map((chatId) =>
					send(
						chatId,
						`🌴 ${bold(me.name)} hat deinen Urlaub (${range}) genehmigt. Gute Erholung!`,
						column([
							{
								text: "❌ Urlaub absagen",
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
			return yield* reject("Zum Zurückziehen nimm „Antrag zurückziehen“.")
		}
		if (vacation.status === "approved") {
			return yield* reject(
				"Der Urlaub ist schon genehmigt – absagen kann ihn nur, wer ihn beantragt hat.",
			)
		}
		const next: State = { ...state, vacations: state.vacations.filter((v) => v.id !== vacationId) }
		const range = vacationRange(vacation, today)
		return {
			state: next,
			toast: "❌ Abgelehnt",
			outbox: [
				send(me.chatId, `❌ Urlaubsantrag (${range}) abgelehnt.`),
				...chatOf(next, vacation.participant).map((chatId) =>
					send(chatId, `❌ ${bold(me.name)} hat deinen Urlaubsantrag (${range}) abgelehnt.`),
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
			toast: "Abgesagt",
			outbox: [
				send(me.chatId, `🗑️ ${what} (${range}) abgesagt. Deine Aufgaben sind wieder deine.`),
				...notifyOthers(next, actor, `🗑️ ${bold(me.name)} hat den ${what} (${range}) abgesagt.`),
			],
		}
	})

// ---------------------------------------------------------------------------
// Task administration
// ---------------------------------------------------------------------------

export interface NewTask {
	readonly name: string
	readonly emoji: string
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
		emoji: spec.emoji,
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
			return yield* reject("Der erste Termin darf nicht in der Vergangenheit liegen.")
		}
		const [task, next] = createTask(state, { ...spec, name })
		const text = `🆕 ${taskLabel(task)} – ${formatCadence(task.cadence)}${task.kind === "joint" ? ", gemeinsam 👫" : ""}, zum ersten Mal ${formatRelativeDate(task.anchor, today)}.`
		return {
			state: next,
			outbox: [
				send(me.chatId, `${text}\nNervigkeit: ${task.annoyance}/10 (ändern mit /nervig)`),
				...notifyOthers(next, actor, `${bold(me.name)} hat eine neue Aufgabe angelegt:\n${text}`),
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
			jokers: state.jokers.filter((j) => j.taskId !== taskId),
		}
		return {
			state: next,
			toast: "🗑️ Gelöscht",
			outbox: [
				send(me.chatId, `🗑️ ${taskLabel(task)} gelöscht.`),
				...notifyOthers(next, actor, `🗑️ ${bold(me.name)} hat ${taskLabel(task)} gelöscht.`),
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
		return {
			state: next,
			toast: `🔔 Nervigkeit ${annoyance}/10 gespeichert`,
			outbox: [
				send(
					me.chatId,
					`🔔 ${taskLabel(task)}: Nervigkeit ${task.annoyance} → ${annoyance}\n\n${formatPreview(annoyance)}`,
				),
				...notifyOthers(
					next,
					actor,
					`🔔 ${bold(me.name)} hat die Nervigkeit von ${taskLabel(task)} von ${task.annoyance} auf ${annoyance} gestellt.`,
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
		const next = replaceTask(state, {
			...task,
			cadence,
			anchor: task.current.dueDate,
			current: { ...task.current, index: 0 },
		})
		const text = `🔁 ${taskLabel(task)}: ${formatCadence(task.cadence)} → ${formatCadence(cadence)}`
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
			return yield* reject("Der Termin darf nicht in der Vergangenheit liegen.")
		}
		const next = replaceTask(state, {
			...task,
			anchor: date,
			current: { ...task.current, index: 0, dueDate: date, misses: 0, lastReminder: null },
		})
		const text = `📅 ${taskLabel(task)} ist jetzt ${formatRelativeDate(date, today)} (${formatDate(date, today)}) fällig.`
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
