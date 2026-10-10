import { Option } from "effect"
import { nthDate } from "./cadence.ts"
import { addDays, isWithin, type LocalDate } from "./calendar.ts"
import type { Participant, ParticipantId, State, Task } from "./model.ts"

export const findParticipant = (state: State, id: ParticipantId): Option.Option<Participant> =>
	Option.fromUndefinedOr(state.participants.find((p) => p.id === id))

export const participantName = (state: State, id: ParticipantId): string =>
	Option.match(findParticipant(state, id), {
		onNone: () => "Unbekannt",
		onSome: (p) => p.name,
	})

export const findTask = (state: State, taskId: string): Option.Option<Task> =>
	Option.fromUndefinedOr(state.tasks.find((t) => t.id === taskId))

export const isOnVacation = (state: State, id: ParticipantId, date: LocalDate): boolean =>
	state.vacations.some(
		(v) => v.status === "approved" && v.participant === id && isWithin(date, v.from, v.to),
	)

export const isAvailable = (state: State, id: ParticipantId, date: LocalDate): boolean =>
	state.participants.some((p) => p.id === id) && !isOnVacation(state, id, date)

/** Owner of the `turn`-th slot of a rotating task according to pure round-robin. */
export const slotOwnerAt = (
	state: State,
	task: Task,
	turn: number,
): Option.Option<ParticipantId> => {
	const n = state.participants.length
	return n === 0
		? Option.none()
		: Option.fromUndefinedOr(state.participants[(task.rotationOffset + turn) % n]?.id)
}

/** First available participant, starting with `preferred` and continuing in rotation order. */
const firstAvailableFrom = (
	state: State,
	preferred: ParticipantId,
	date: LocalDate,
): Option.Option<ParticipantId> => {
	const ids = state.participants.map((p) => p.id)
	const start = Math.max(0, ids.indexOf(preferred))
	const rotated = [...ids.slice(start), ...ids.slice(0, start)]
	if (!ids.includes(preferred)) {
		// The preferred person left the household; fall back to plain rotation order.
		return Option.fromUndefinedOr(ids.find((id) => isAvailable(state, id, date)))
	}
	return Option.fromUndefinedOr(rotated.find((id) => isAvailable(state, id, date)))
}

/**
 * Who has to do the task's current occurrence if it happens on `date`.
 * Rotating tasks: the assignee override or the slot owner, substituted if on vacation.
 * Joint tasks: everybody – but only if nobody is on vacation (otherwise it gets postponed).
 * An empty result means nobody can do it that day and the occurrence gets postponed.
 */
export const responsibleOn = (
	state: State,
	task: Task,
	date: LocalDate,
): ReadonlyArray<ParticipantId> => {
	if (task.kind === "joint") {
		const ids = state.participants.map((p) => p.id)
		return ids.some((id) => isOnVacation(state, id, date)) ? [] : ids
	}
	const base = Option.orElse(Option.fromNullOr(task.current.assignee), () =>
		slotOwnerAt(state, task, task.turn),
	)
	return Option.match(
		Option.flatMap(base, (id) => firstAvailableFrom(state, id, date)),
		{ onNone: () => [], onSome: (id) => [id] },
	)
}

export const isResponsible = (
	state: State,
	task: Task,
	date: LocalDate,
	id: ParticipantId,
): boolean => responsibleOn(state, task, date).includes(id)

export interface PlannedOccurrence {
	readonly task: Task
	readonly index: number
	readonly date: LocalDate
	readonly responsible: ReadonlyArray<ParticipantId>
	readonly isCurrent: boolean
	readonly misses: number
}

/** Pushes `date` forward until somebody can do the task (bounded, in case everyone is away). */
const firstWorkableDate = (
	state: State,
	responsibleAt: (date: LocalDate) => ReadonlyArray<ParticipantId>,
	date: LocalDate,
): LocalDate => {
	let candidate = date
	for (let i = 0; i < 400 && responsibleAt(candidate).length === 0; i++) {
		candidate = addDays(candidate, 1)
	}
	return state.participants.length === 0 ? date : candidate
}

/**
 * Forecast of a task's occurrences from its current one up to `until` (inclusive), assuming
 * every occurrence gets done on its due day. Vacation substitutions/postponements are applied.
 */
export const projectTask = (
	state: State,
	task: Task,
	until: LocalDate,
): ReadonlyArray<PlannedOccurrence> => {
	const result: Array<PlannedOccurrence> = []
	const currentDate = firstWorkableDate(
		state,
		(d) => responsibleOn(state, task, d),
		task.current.dueDate,
	)
	if (currentDate > until) {
		return result
	}
	result.push({
		task,
		index: task.current.index,
		date: currentDate,
		responsible: responsibleOn(state, task, currentDate),
		isCurrent: true,
		misses: task.current.misses,
	})

	let index = task.current.index + 1
	let turn = task.turn + 1
	let previous = currentDate
	for (let guard = 0; guard < 1000; guard++, index++) {
		const gridDate = nthDate(task.anchor, task.cadence, index)
		if (gridDate <= previous) {
			continue
		}
		const future: Task = {
			...task,
			turn,
			current: { index, dueDate: gridDate, assignee: null, misses: 0, lastReminder: null },
		}
		const date = firstWorkableDate(state, (d) => responsibleOn(state, future, d), gridDate)
		if (date > until) {
			break
		}
		result.push({
			task,
			index,
			date,
			responsible: responsibleOn(state, future, date),
			isCurrent: false,
			misses: 0,
		})
		previous = date
		turn++
	}
	return result
}

/** All projected occurrences of all tasks between `from` and `until`, sorted by date. */
export const projectAll = (
	state: State,
	from: LocalDate,
	until: LocalDate,
): ReadonlyArray<PlannedOccurrence> =>
	state.tasks
		.flatMap((task) => projectTask(state, task, until))
		.filter((o) => o.date >= from || o.isCurrent)
		.toSorted((a, b) => a.date.localeCompare(b.date) || a.task.name.localeCompare(b.task.name))
