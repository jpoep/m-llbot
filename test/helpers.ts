import { Effect } from "effect"
import { createTask, join, type NewTask, type Transition } from "../src/domain/actions.ts"
import { cadence } from "../src/domain/cadence.ts"
import { addDays, LocalDate, type LocalMoment } from "../src/domain/calendar.ts"
import { ParticipantId, type State, type Task } from "../src/domain/model.ts"
import type { Outgoing } from "../src/domain/outbox.ts"
import { emptyState } from "../src/domain/seed.ts"
import { tick } from "../src/domain/tick.ts"

export const A = ParticipantId.make(1001)
export const B = ParticipantId.make(1002)
export const C = ParticipantId.make(1003)
const NAMES = new Map<number, string>([
	[A, "Anna"],
	[B, "Ben"],
])
export const chatOf = (id: ParticipantId): number => id + 5000

export const DAY0 = LocalDate.make("2026-10-12")
export const day = (n: number): LocalDate => addDays(DAY0, n)
export const at = (n: number, hh: number, mm = 0): LocalMoment => ({
	date: day(n),
	minute: hh * 60 + mm,
})

export const run = <A, E>(effect: Effect.Effect<A, E>): A => Effect.runSync(effect)
export const fail = <A, E>(effect: Effect.Effect<A, E>): E => Effect.runSync(Effect.flip(effect))

export const withPeople = (state: State, ...ids: ReadonlyArray<ParticipantId>): State =>
	ids.reduce(
		(s, id) => run(join(s, { id, name: NAMES.get(id) ?? "Cleo", chatId: chatOf(id) })).state,
		state,
	)

export const spec = (overrides: Partial<NewTask> = {}): NewTask => ({
	name: "Müll runterbringen",
	emoji: "🗑️",
	cadence: cadence(2, "day"),
	kind: "rotating",
	firstDue: day(2),
	annoyance: 3,
	...overrides,
})

/** A household with Anna and Ben and the given tasks, already rolled over to DAY0. */
export const household = (...specs: ReadonlyArray<NewTask>): State => {
	const base = withPeople({ ...emptyState, lastRollover: DAY0, lastDigest: DAY0 }, A, B)
	return specs.reduce((s, t) => createTask(s, t)[1], base)
}

export const task = (state: State, index = 0): Task => {
	const t = state.tasks[index]
	if (t === undefined) {
		throw new Error(`no task at ${index}`)
	}
	return t
}

/** Runs the per-minute tick for every minute in [from, to] and collects everything. */
export const runTicks = (
	state: State,
	from: LocalMoment,
	to: LocalMoment,
): {
	state: State
	outbox: ReadonlyArray<Outgoing>
	byMinute: Map<string, ReadonlyArray<Outgoing>>
} => {
	let current = state
	const outbox: Array<Outgoing> = []
	const byMinute = new Map<string, ReadonlyArray<Outgoing>>()
	let moment = from
	while (moment.date < to.date || (moment.date === to.date && moment.minute <= to.minute)) {
		const result: Transition = run(tick(current, moment))
		current = result.state
		if (result.outbox.length > 0) {
			byMinute.set(`${moment.date} ${moment.minute}`, result.outbox)
			outbox.push(...result.outbox)
		}
		moment =
			moment.minute === 24 * 60 - 1
				? { date: addDays(moment.date, 1), minute: 0 }
				: { date: moment.date, minute: moment.minute + 1 }
	}
	return { state: current, outbox, byMinute }
}

export const textsTo = (
	outbox: ReadonlyArray<Outgoing>,
	id: ParticipantId,
): ReadonlyArray<string> => outbox.filter((m) => m.chatId === chatOf(id)).map((m) => m.text)
