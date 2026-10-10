import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import {
	approveReschedule,
	cancelReschedule,
	complete,
	rejectReschedule,
	requestReschedule,
	takeOver,
} from "../src/domain/actions.ts"
import { cadence } from "../src/domain/cadence.ts"
import { State } from "../src/domain/model.ts"
import type { Outgoing } from "../src/domain/outbox.ts"
import { responsibleOn } from "../src/domain/schedule.ts"
import { initialState } from "../src/domain/seed.ts"
import { HELP_TEXT, reminderHeadline } from "../src/domain/texts.ts"
import { rolloverDay } from "../src/domain/tick.ts"
import {
	jokerView,
	planView,
	rescheduleDatePicker,
	reschedulePicker,
	statsView,
	tasksView,
	todayView,
	vacationsView,
} from "../src/domain/views.ts"
import {
	A,
	at,
	B,
	chatOf,
	day,
	fail,
	household,
	run,
	runTicks,
	spec,
	task,
	textsTo,
} from "./helpers.ts"

const requestId = (state: State): string => state.reschedules[0]?.id ?? ""

describe("one-off reschedule", () => {
	test("needs approval, then moves only this occurrence", () => {
		const state = household(spec({ cadence: cadence(3, "day"), firstDue: day(2) }))
		const t = task(state)
		const requested = run(requestReschedule(state, A, t.id, t.current.index, day(3), day(1)))
		expect(task(requested.state).current.dueDate).toBe(day(2))
		const toBen = requested.outbox.find((m) => m.chatId === chatOf(B))
		expect(toBen?.keyboard.flat().map((b) => b.text)).toEqual(["Genehmigen", "Ablehnen"])

		const approved = run(approveReschedule(requested.state, B, requestId(requested.state), day(1)))
		expect(task(approved.state).current.dueDate).toBe(day(3))
		expect(approved.state.reschedules).toHaveLength(0)
		expect(textsTo(approved.outbox, A).join()).toContain("zugestimmt")

		// The cadence grid is untouched: after doing it on day 3, the next one is on day 5 as before.
		const after = run(complete(approved.state, A, t.id, t.current.index, day(3))).state
		expect(task(after).current.dueDate).toBe(day(5))
		expect(responsibleOn(after, task(after), day(5))).toEqual([B])
	})

	test("moving a task to later means no penalty on the original day", () => {
		const state = household(spec({ firstDue: day(2) }))
		const t = task(state)
		const requested = run(requestReschedule(state, A, t.id, t.current.index, day(4), day(1))).state
		const approved = run(approveReschedule(requested, B, requestId(requested), day(1))).state
		const next = rolloverDay(approved, day(3)).state
		expect(next.jokers).toHaveLength(0)
		expect(task(next).current.dueDate).toBe(day(4))
	})

	test("only the responsible person can ask, and nobody approves their own request", () => {
		const state = household(spec({ firstDue: day(2) }))
		const t = task(state)
		expect(
			fail(requestReschedule(state, B, t.id, t.current.index, day(3), day(1))).reason,
		).toContain("wer dran ist")
		const requested = run(requestReschedule(state, A, t.id, t.current.index, day(3), day(1))).state
		expect(fail(approveReschedule(requested, A, requestId(requested), day(1))).reason).toContain(
			"eigene Anfrage",
		)
		expect(
			fail(requestReschedule(requested, A, t.id, t.current.index, day(4), day(1))).reason,
		).toContain("läuft schon")
	})

	test("joint tasks can be moved by anyone", () => {
		const state = household(spec({ kind: "joint", firstDue: day(2) }))
		const t = task(state)
		const requested = run(requestReschedule(state, B, t.id, t.current.index, day(5), day(1))).state
		expect(
			run(approveReschedule(requested, A, requestId(requested), day(1))).state.tasks[0]?.current
				.dueDate,
		).toBe(day(5))
	})

	test("rejects nonsense dates", () => {
		const state = household(spec({ firstDue: day(2) }))
		const t = task(state)
		const ask = (to: number) =>
			fail(requestReschedule(state, A, t.id, t.current.index, day(to), day(1))).reason
		expect(ask(0)).toContain("Vergangenheit")
		expect(ask(2)).toContain("bereits der Termin")
		expect(ask(30)).toContain("Höchstens")
	})

	test("can be rejected or withdrawn", () => {
		const state = household(spec({ firstDue: day(2) }))
		const t = task(state)
		const requested = run(requestReschedule(state, A, t.id, t.current.index, day(3), day(1))).state
		const rejected = run(rejectReschedule(requested, B, requestId(requested), day(1)))
		expect(task(rejected.state).current.dueDate).toBe(day(2))
		expect(textsTo(rejected.outbox, A).join()).toContain("abgelehnt")
		expect(fail(cancelReschedule(requested, B, requestId(requested))).reason).toContain("Nur wer")
		expect(
			run(cancelReschedule(requested, A, requestId(requested))).state.reschedules,
		).toHaveLength(0)
	})

	test("requests become stale once the occurrence is done", () => {
		const state = household(spec({ firstDue: day(2) }))
		const t = task(state)
		const requested = run(requestReschedule(state, A, t.id, t.current.index, day(3), day(1))).state
		const done = run(complete(requested, A, t.id, t.current.index, day(1))).state
		expect(done.reschedules).toHaveLength(0)
		// A stale request that slipped through (e.g. approved from an old message) is refused.
		const withStale = { ...done, reschedules: requested.reschedules }
		expect(fail(approveReschedule(withStale, B, requestId(requested), day(1))).reason).toContain(
			"nicht mehr aktuell",
		)
		expect(rolloverDay(withStale, day(2)).state.reschedules).toHaveLength(0)
	})

	test("pickers offer the right tasks and dates", () => {
		const state = household(spec({ firstDue: day(2) }))
		expect(reschedulePicker(state, A, day(1)).keyboard).toHaveLength(1)
		expect(reschedulePicker(state, B, day(1)).keyboard).toHaveLength(0)
		const dates = rescheduleDatePicker(state, task(state), day(1)).keyboard.flat()
		expect(dates.map((b) => b.text)).toContain("heute")
		expect(dates.map((b) => b.text)).not.toContain("morgen") // that's the current due date
	})
})

describe("persisted state from before this change", () => {
	test("still decodes (old task emojis are dropped, reschedules default to empty)", () => {
		const encoded = Schema.encodeSync(Schema.fromJsonString(State))(initialState(day(0)))
		const legacy = JSON.parse(encoded) as {
			tasks: Array<Record<string, unknown>>
			reschedules?: unknown
		}
		for (const t of legacy.tasks) {
			t["emoji"] = "x"
		}
		delete legacy.reschedules
		const decoded = Schema.decodeUnknownSync(Schema.fromJsonString(State))(JSON.stringify(legacy))
		expect(decoded.reschedules).toEqual([])
		expect(decoded.tasks[0]).not.toHaveProperty("emoji")
	})
})

describe("tone", () => {
	const EMOJI = /\p{Extended_Pictographic}/u
	const texts = (outbox: ReadonlyArray<Outgoing>): ReadonlyArray<string> =>
		outbox.flatMap((m) => [m.text, ...m.keyboard.flat().map((b) => b.text)])

	test("no message, view or button contains an emoji", () => {
		let state = household(
			spec({ firstDue: day(1), annoyance: 10 }),
			spec({ name: "Fenster", kind: "joint", firstDue: day(1) }),
		)
		const collected: Array<string> = [HELP_TEXT]
		const t = task(state)
		const takeover = run(takeOver(state, B, t.id, t.current.index, day(0)))
		collected.push(...texts(takeover.outbox))
		const ticks = runTicks(state, at(1, 0), at(2, 9)) // digest, reminders, misses, jokers
		collected.push(...texts(ticks.outbox))
		state = ticks.state
		const requested = run(
			requestReschedule(state, A, t.id, task(state).current.index, day(3), day(2)),
		)
		collected.push(...texts(requested.outbox))
		for (const v of [
			todayView(state, A, day(2)),
			planView(state, day(2)),
			tasksView(state, day(2)),
			statsView(state),
			jokerView(state, B, at(2, 9)),
			vacationsView(state, A, day(2)),
			reschedulePicker(state, A, day(2)),
		]) {
			collected.push(v.text, ...v.keyboard.flat().map((b) => b.text))
		}
		for (let m = 0; m < 24 * 60; m += 7) {
			collected.push(reminderHeadline(m, m))
		}
		expect(collected.length).toBeGreaterThan(30)
		expect(collected.filter((text) => EMOJI.test(text))).toEqual([])
	})
})
