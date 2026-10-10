import { Clock, Effect, Schedule } from "effect"
import type { Transition } from "../domain/actions.ts"
import { type LocalMoment, momentFromEpochMillis } from "../domain/calendar.ts"
import type { State } from "../domain/model.ts"
import { initialState } from "../domain/seed.ts"
import { settings } from "../settings.ts"
import { StateStore, StoreError } from "./StateStore.ts"
import { Telegram } from "./Telegram.ts"

/** The current wall-clock moment in the household's time zone (driven by Effect's `Clock`). */
export const currentMoment: Effect.Effect<LocalMoment> = Effect.map(Clock.currentTimeMillis, (ms) =>
	momentFromEpochMillis(ms, settings.timeZone),
)

const loadOrInit = (today: LocalMoment["date"]) =>
	Effect.gen(function* () {
		const store = yield* StateStore
		const { state, version } = yield* store.load
		return { state: state ?? initialState(today), version }
	})

/** Read-only access to the current state (for views). */
export const readState: Effect.Effect<{ state: State; now: LocalMoment }, StoreError, StateStore> =
	Effect.gen(function* () {
		const now = yield* currentMoment
		const { state } = yield* loadOrInit(now.date)
		return { state, now }
	})

/**
 * Load → apply a pure transition → save with optimistic locking → deliver messages.
 * On a version conflict the whole thing is retried against the fresh state. Messages are only
 * sent after a successful save, so a retried transition never double-sends.
 */
export const transact = <E>(
	apply: (state: State, now: LocalMoment) => Effect.Effect<Transition, E>,
): Effect.Effect<Transition, E | StoreError, StateStore | Telegram> =>
	Effect.gen(function* () {
		const store = yield* StateStore
		const telegram = yield* Telegram

		const attempt = Effect.gen(function* () {
			const now = yield* currentMoment
			const { state, version } = yield* loadOrInit(now.date)
			const transition = yield* apply(state, now)
			if (version === 0 || JSON.stringify(transition.state) !== JSON.stringify(state)) {
				yield* store.save(transition.state, version)
			}
			return transition
		})

		const transition = yield* attempt.pipe(
			Effect.retry({
				while: (error) => error instanceof Object && "_tag" in error && error._tag === "Conflict",
				schedule: Schedule.exponential("20 millis"),
				times: 8,
			}),
			Effect.catchTag("Conflict", (cause) => Effect.fail(new StoreError({ cause }))),
		)
		yield* telegram.deliver(transition.outbox)
		return transition
	})
