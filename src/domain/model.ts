import { Effect, Schema } from "effect"
import { Annoyance } from "./annoyance.ts"
import { Cadence } from "./cadence.ts"
import { LocalDate } from "./calendar.ts"

/** Telegram user id. */
export const ParticipantId = Schema.Int.pipe(Schema.brand("ParticipantId"))
export type ParticipantId = typeof ParticipantId.Type

const Count = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
const MinuteOfDay = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 24 * 60 - 1 }))

export const Stats = Schema.Struct({
	done: Count,
	missed: Count,
	jokersPlayed: Count,
	takeovers: Count,
})
export type Stats = typeof Stats.Type

export const Participant = Schema.Struct({
	id: ParticipantId,
	name: Schema.String,
	/** Private chat with the bot, where all personal messages go. */
	chatId: Schema.Int,
	stats: Stats,
})
export type Participant = typeof Participant.Type

/**
 * - `rotating`: round-robin between all participants.
 * - `joint`: everyone does it together; whoever ticks it off clears it for all.
 */
export const TaskKind = Schema.Literals(["rotating", "joint"])
export type TaskKind = typeof TaskKind.Type

export const ReminderMark = Schema.Struct({ date: LocalDate, minute: MinuteOfDay })
export type ReminderMark = typeof ReminderMark.Type

/** The single pending occurrence of a task. Future occurrences are derived, never stored. */
export const Occurrence = Schema.Struct({
	/** Position on the task's cadence grid (`nthDate(anchor, cadence, index)`). */
	index: Count,
	/** Usually the grid date; later if the occurrence was missed or postponed. */
	dueDate: LocalDate,
	/** Overrides the rotation for this occurrence (joker, take-over, or the culprit of a miss). */
	assignee: Schema.NullOr(ParticipantId),
	/** How many days in a row this occurrence was missed. */
	misses: Count,
	/** Last evening reminder that was sent for this occurrence. */
	lastReminder: Schema.NullOr(ReminderMark),
})
export type Occurrence = typeof Occurrence.Type

export const Task = Schema.Struct({
	id: Schema.String,
	name: Schema.String,
	kind: TaskKind,
	cadence: Cadence,
	annoyance: Annoyance,
	anchor: LocalDate,
	/**
	 * Rotation counter: the slot owner of the current occurrence is
	 * `participants[(rotationOffset + turn) % participants.length]`. Incremented on every completion.
	 */
	rotationOffset: Count,
	turn: Count,
	current: Occurrence,
})
export type Task = typeof Task.Type

/** Earned when someone else misses a rotating task. Makes the debtor do one of your turns. */
export const Joker = Schema.Struct({
	id: Schema.String,
	taskId: Schema.String,
	holder: ParticipantId,
	debtor: ParticipantId,
	earnedOn: LocalDate,
})
export type Joker = typeof Joker.Type

export const VacationStatus = Schema.Literals(["pending", "approved"])
export type VacationStatus = typeof VacationStatus.Type

export const Vacation = Schema.Struct({
	id: Schema.String,
	participant: ParticipantId,
	from: LocalDate,
	to: LocalDate,
	status: VacationStatus,
})
export type Vacation = typeof Vacation.Type

/** A one-off move of a single occurrence, waiting for someone else's approval. */
export const RescheduleRequest = Schema.Struct({
	id: Schema.String,
	taskId: Schema.String,
	/** The occurrence it applies to; stale once that occurrence is done. */
	index: Count,
	requester: ParticipantId,
	from: LocalDate,
	to: LocalDate,
})
export type RescheduleRequest = typeof RescheduleRequest.Type

export const State = Schema.Struct({
	participants: Schema.Array(Participant),
	tasks: Schema.Array(Task),
	jokers: Schema.Array(Joker),
	vacations: Schema.Array(Vacation),
	reschedules: Schema.Array(RescheduleRequest).pipe(
		Schema.withDecodingDefaultKey(Effect.succeed([])),
	),
	/** Last day whose midnight rollover (miss detection, postponing) has been processed. */
	lastRollover: Schema.NullOr(LocalDate),
	/** Last day for which the morning digest was sent. */
	lastDigest: Schema.NullOr(LocalDate),
	/** Monotonic counter for short, callback-data friendly ids. */
	nextId: Count,
})
export type State = typeof State.Type

export const emptyStats: Stats = { done: 0, missed: 0, jokersPlayed: 0, takeovers: 0 }
