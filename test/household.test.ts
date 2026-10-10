import { describe, expect, test } from "bun:test"
import { Effect, Layer, Ref } from "effect"
import { complete } from "../src/domain/actions.ts"
import { transact } from "../src/services/Household.ts"
import { InMemoryStateStore, StateStore } from "../src/services/StateStore.ts"
import { RecordingTelegram } from "../src/services/Telegram.ts"
import { A, household, spec } from "./helpers.ts"

describe("transact", () => {
	test("initializes the household with the default tasks on first use", async () => {
		const program = Effect.gen(function* () {
			const { sent, layer } = yield* RecordingTelegram
			const result = yield* transact((state) => Effect.succeed({ state, outbox: [] })).pipe(
				Effect.provide(Layer.merge(InMemoryStateStore(), layer)),
			)
			return { names: result.state.tasks.map((t) => t.name), sent: yield* Ref.get(sent) }
		})
		const { names, sent } = await Effect.runPromise(program)
		expect(names).toEqual([
			"Müll runterbringen",
			"Bad putzen",
			"Flur, Küche, Wohnzimmer saugen",
			"Hausflur saugen",
			"Fenster putzen",
		])
		expect(sent).toHaveLength(0)
	})

	test("retries on a version conflict and only delivers messages once", async () => {
		const initial = household(spec({ firstDue: "2026-10-10" as never }))
		const program = Effect.gen(function* () {
			const { sent, layer } = yield* RecordingTelegram
			let attempts = 0
			const result = yield* Effect.gen(function* () {
				const store = yield* StateStore
				return yield* transact((state, now) =>
					Effect.gen(function* () {
						attempts++
						if (attempts === 1) {
							// Someone else writes in between our load and save.
							const { version } = yield* store.load.pipe(Effect.orDie)
							yield* store.save(state, version).pipe(Effect.orDie)
						}
						const t = state.tasks[0]
						if (t === undefined) {
							return yield* Effect.die("missing task")
						}
						return yield* complete(state, A, t.id, t.current.index, now.date)
					}),
				)
			}).pipe(Effect.provide(Layer.merge(InMemoryStateStore(initial), layer)))
			return { attempts, toast: result.toast, sent: yield* Ref.get(sent) }
		})
		const { attempts, toast, sent } = await Effect.runPromise(program)
		expect(attempts).toBe(2)
		expect(toast).toBe("✅ Erledigt!")
		expect(sent).toHaveLength(2)
	})
})
