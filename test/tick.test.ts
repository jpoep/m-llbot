import { describe, expect, test } from "bun:test"
import { complete } from "../src/domain/actions.ts"
import { reminderMinutes } from "../src/domain/annoyance.ts"
import { cadence } from "../src/domain/cadence.ts"
import type { State } from "../src/domain/model.ts"
import { tick } from "../src/domain/tick.ts"
import { A, at, B, day, household, run, runTicks, spec, task, textsTo } from "./helpers.ts"

/** Pretends the morning digest of day `n` was already sent, to isolate evening reminders. */
const skipDigest = (state: State, n: number): State => ({ ...state, lastDigest: day(n) })

describe("morning digest", () => {
	test("is sent once at 08:00 to whoever has something due today or tomorrow", () => {
		const state = household(
			spec({ firstDue: day(1) }),
			spec({ name: "Bad putzen", firstDue: day(5) }),
		)
		const { outbox, byMinute } = runTicks(state, at(1, 0), at(1, 12))
		const digestMinute = [...byMinute.keys()].filter((k) => k.endsWith(` ${8 * 60}`))
		expect(digestMinute).toHaveLength(1)
		const toAnna = textsTo(outbox, A)
		expect(toAnna).toHaveLength(1)
		expect(toAnna[0]).toContain("Heute fällig")
		expect(toAnna[0]).toContain("Müll runterbringen")
		// Ben's next turn is on day 3, so there is nothing to tell him yet.
		expect(textsTo(outbox, B)).toHaveLength(0)
	})

	test("flags overdue tasks and mentions playable jokers", () => {
		// Every 2 days: A misses day 1 → B gets a joker. A catches up on day 2, B is up on day 3.
		const missed = runTicks(household(spec({ firstDue: day(1) })), at(1, 0), at(2, 8))
		expect(textsTo(missed.outbox, A).at(-1)).toContain("überfällig")
		const t = task(missed.state)
		const caughtUp = run(complete(missed.state, A, t.id, t.current.index, day(2))).state
		const { outbox } = runTicks(caughtUp, at(2, 9), at(3, 8))
		expect(textsTo(outbox, B).at(-1)).toContain("Joker, der sich hier einsetzen lässt")
	})
})

describe("evening escalation", () => {
	test("sends exactly the previewed reminders, grouped per person, and stops when done", () => {
		const state = household(
			spec({ firstDue: day(1), annoyance: 3 }),
			spec({ name: "Saugen", firstDue: day(1), annoyance: 5 }),
		)
		const { outbox, byMinute } = runTicks(skipDigest(state, 1), at(1, 9), at(1, 23, 59))
		const expected = new Set([...reminderMinutes(3), ...reminderMinutes(5)])
		const minutes = [...byMinute.keys()].map((k) => Number(k.split(" ")[1]))
		expect(new Set(minutes)).toEqual(expected)
		// One message per person and minute, even with two tasks.
		for (const messages of byMinute.values()) {
			expect(new Set(messages.map((m) => m.chatId)).size).toBe(messages.length)
		}
		expect(outbox.length).toBeGreaterThan(20)
	})

	test("a late tick catches up with a single message instead of a burst", () => {
		const state = household(spec({ firstDue: day(1), annoyance: 10 }))
		const first = run(tick(skipDigest(state, 1), at(1, 18, 0)))
		expect(first.outbox).toHaveLength(1)
		const skipped = run(tick(first.state, at(1, 19, 0)))
		expect(skipped.outbox).toHaveLength(1)
		const again = run(tick(skipped.state, at(1, 19, 0)))
		expect(again.outbox).toHaveLength(0)
	})

	test("nothing is sent once the task is done", () => {
		const state = household(spec({ firstDue: day(1), annoyance: 10 }))
		const t = task(state)
		const done = { ...state, tasks: [{ ...t, current: { ...t.current, dueDate: day(4) } }] }
		expect(runTicks(skipDigest(done, 1), at(1, 18), at(1, 23, 59)).outbox).toHaveLength(0)
	})

	test("level 0 stays silent in the evening, but misses turn the dial up", () => {
		let state = household(spec({ firstDue: day(1), annoyance: 0, cadence: cadence(1, "day") }))
		const evening = runTicks(skipDigest(state, 1), at(1, 9), at(1, 23, 59))
		expect(evening.outbox).toHaveLength(0)
		state = runTicks(evening.state, at(2, 0), at(2, 0)).state
		expect(task(state).current.misses).toBe(1)
		const nextEvening = runTicks(skipDigest(state, 2), at(2, 9), at(2, 23, 59))
		expect(nextEvening.outbox.length).toBe(reminderMinutes(2).length)
	})

	test("reminders get more urgent towards midnight", () => {
		const state = household(spec({ firstDue: day(1), annoyance: 10 }))
		const late = run(tick(skipDigest(state, 1), at(1, 23, 58)))
		expect(late.outbox[0]?.text).toMatch(/2 Minuten|Ich habe Zeit/)
	})
})

describe("midnight rollover", () => {
	test("catches up on all days missed while the bot was down", () => {
		const state = household(spec({ firstDue: day(1), cadence: cadence(1, "day") }))
		const result = run(tick(state, at(4, 10)))
		expect(result.state.lastRollover).toBe(day(4))
		expect(task(result.state).current.misses).toBe(3)
		expect(task(result.state).current.dueDate).toBe(day(4))
	})
})
