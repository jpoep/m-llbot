import { describe, expect, test } from "bun:test"
import {
	approveVacation,
	cancelVacation,
	complete,
	playJoker,
	rejectVacation,
	requestVacation,
	takeOver,
} from "../src/domain/actions.ts"
import { cadence } from "../src/domain/cadence.ts"
import type { State } from "../src/domain/model.ts"
import { projectTask, responsibleOn } from "../src/domain/schedule.ts"
import { rolloverDay } from "../src/domain/tick.ts"
import {
	A,
	at,
	B,
	C,
	chatOf,
	day,
	fail,
	household,
	run,
	spec,
	task,
	textsTo,
	withPeople,
} from "./helpers.ts"

const doneBy = (state: State, who: typeof A, today: number, index = 0): State => {
	const t = task(state, index)
	return run(complete(state, who, t.id, t.current.index, day(today))).state
}

describe("round robin", () => {
	test("every 2 days alternates between participants: A on day 2, B on day 4, A on day 6", () => {
		let state = household(spec({ cadence: cadence(2, "day"), firstDue: day(2) }))
		const seen: Array<[string, ReadonlyArray<number>]> = []
		for (const d of [2, 4, 6, 8]) {
			const t = task(state)
			expect(t.current.dueDate).toBe(day(d))
			const responsible = responsibleOn(state, t, day(d))
			seen.push([day(d), responsible])
			state = doneBy(state, responsible[0] ?? A, d)
		}
		expect(seen.map(([, r]) => r[0])).toEqual([A, B, A, B])
	})

	test("works for n participants", () => {
		let state = withPeople(household(spec({ cadence: cadence(1, "day"), firstDue: day(1) })), C)
		const order: Array<number | undefined> = []
		for (const d of [1, 2, 3, 4]) {
			const who = responsibleOn(state, task(state), day(d))[0]
			order.push(who)
			state = doneBy(state, who ?? A, d)
		}
		expect(order).toEqual([A, B, C, A])
	})

	test("tasks are spread: the second task starts with the second person", () => {
		const state = household(spec(), spec({ name: "Bad putzen", cadence: cadence(2, "week") }))
		expect(responsibleOn(state, task(state, 0), day(2))).toEqual([A])
		expect(responsibleOn(state, task(state, 1), day(2))).toEqual([B])
	})

	test("only the responsible person can tick off a rotating task", () => {
		const state = household(spec())
		const t = task(state)
		expect(fail(complete(state, B, t.id, t.current.index, day(2))).reason).toContain(
			"nicht deine Aufgabe",
		)
	})

	test("old buttons are rejected after completion", () => {
		const state = household(spec())
		const t = task(state)
		const after = doneBy(state, A, 2)
		expect(fail(complete(after, A, t.id, t.current.index, day(2))).reason).toContain(
			"schon erledigt",
		)
	})

	test("completing early keeps the grid, completing late skips past grid dates", () => {
		const early = doneBy(household(spec({ cadence: cadence(1, "week"), firstDue: day(7) })), A, 5)
		expect(task(early).current.dueDate).toBe(day(14))

		const late = doneBy(household(spec({ cadence: cadence(2, "day"), firstDue: day(2) })), A, 5)
		expect(task(late).current.dueDate).toBe(day(6))
	})

	test("joint tasks are due for everyone and cleared by anyone", () => {
		const state = household(spec({ kind: "joint", cadence: cadence(1, "year"), firstDue: day(3) }))
		const t = task(state)
		expect(responsibleOn(state, t, day(3))).toEqual([A, B])
		const result = run(complete(state, B, t.id, t.current.index, day(3)))
		expect(task(result.state).current.dueDate).toBe(day(368))
		expect(textsTo(result.outbox, A).join()).toContain("für alle abgehakt")
	})
})

describe("missing a day", () => {
	test("reschedules to the next day, keeps the culprit, gives everyone else a joker", () => {
		const state = withPeople(household(spec({ firstDue: day(2) })), C)
		const { state: next, outbox } = rolloverDay(state, day(3))
		const t = task(next)
		expect(t.current.dueDate).toBe(day(3))
		expect(t.current.assignee).toBe(A)
		expect(t.current.misses).toBe(1)
		expect(next.jokers.map((j) => [j.holder, j.debtor])).toEqual([
			[B, A],
			[C, A],
		])
		expect(next.participants.find((p) => p.id === A)?.stats.missed).toBe(1)
		expect(textsTo(outbox, A).join()).toContain("heute wieder fällig")
		expect(textsTo(outbox, B).join()).toContain("Joker")
	})

	test("rotation continues normally after the culprit finally does it", () => {
		let state = rolloverDay(household(spec({ firstDue: day(2) })), day(3)).state
		state = doneBy(state, A, 3)
		const t = task(state)
		expect(t.current.dueDate).toBe(day(4))
		expect(responsibleOn(state, t, day(4))).toEqual([B])
	})

	test("joint misses are rescheduled without jokers", () => {
		const state = household(spec({ kind: "joint", firstDue: day(2) }))
		const next = rolloverDay(state, day(3)).state
		expect(task(next).current.dueDate).toBe(day(3))
		expect(next.jokers).toHaveLength(0)
	})
})

describe("jokers", () => {
	// A misses day 2 → B gets a joker against A. A does it on day 3. B is up on day 4.
	const setup = () => doneBy(rolloverDay(household(spec({ firstDue: day(2) })), day(3)).state, A, 3)

	test("can be played before noon on the due day and hands the turn to the debtor", () => {
		const state = setup()
		const t = task(state)
		const result = run(playJoker(state, B, t.id, t.current.index, at(4, 11, 59)))
		expect(responsibleOn(result.state, task(result.state), day(4))).toEqual([A])
		expect(result.state.jokers).toHaveLength(0)
		expect(textsTo(result.outbox, A).join()).toContain("Joker")
		// Rotation goes on as if B had done it: day 6 is A's regular turn.
		const after = doneBy(result.state, A, 4)
		expect(responsibleOn(after, task(after), day(6))).toEqual([A])
	})

	test("can be played days before the task is due", () => {
		const state = setup()
		const t = task(state)
		expect(run(playJoker(state, B, t.id, t.current.index, at(3, 20))).state.jokers).toHaveLength(0)
	})

	test("cannot be played after the cutoff", () => {
		const state = setup()
		const t = task(state)
		expect(fail(playJoker(state, B, t.id, t.current.index, at(4, 12, 0))).reason).toContain(
			"Zu spät",
		)
	})

	test("cannot be played without a joker or for someone else's turn", () => {
		const state = setup()
		const t = task(state)
		expect(fail(playJoker(state, A, t.id, t.current.index, at(4, 8))).reason).toContain(
			"eigenen Termine",
		)
		const fresh = household(spec({ firstDue: day(2) }))
		const ft = task(fresh)
		expect(fail(playJoker(fresh, A, ft.id, ft.current.index, at(1, 8))).reason).toContain("keinen")
	})

	test("cannot push the task onto someone on vacation", () => {
		let state = setup()
		state = {
			...state,
			vacations: [{ id: "v9", participant: A, from: day(4), to: day(5), status: "approved" }],
		}
		const t = task(state)
		expect(fail(playJoker(state, B, t.id, t.current.index, at(4, 8))).reason).toContain(
			"keinen einsetzbaren",
		)
	})
})

describe("taking over", () => {
	test("reassigns the occurrence without awarding anything; rotation continues", () => {
		const state = household(spec({ firstDue: day(2) }))
		const t = task(state)
		const result = run(takeOver(state, B, t.id, t.current.index, day(1)))
		expect(responsibleOn(result.state, task(result.state), day(2))).toEqual([B])
		expect(result.state.jokers).toHaveLength(0)
		expect(textsTo(result.outbox, A).join()).toContain("übernimmt")
		const after = doneBy(result.state, B, 2)
		// Day 4 is B's regular turn – taking over is a gift, not a swap.
		expect(responsibleOn(after, task(after), day(4))).toEqual([B])
	})

	test("rejects taking over your own task", () => {
		const state = household(spec({ firstDue: day(2) }))
		const t = task(state)
		expect(fail(takeOver(state, A, t.id, t.current.index, day(1))).reason).toContain(
			"sowieso deine",
		)
	})
})

describe("vacation", () => {
	const requestAndApprove = (state: State, from: number, to: number): State => {
		const requested = run(requestVacation(state, A, day(from), day(to), day(0))).state
		const id = requested.vacations[0]?.id ?? ""
		return run(approveVacation(requested, B, id, day(0))).state
	}

	test("needs approval by someone else", () => {
		const state = household(spec())
		const requested = run(requestVacation(state, A, day(1), day(5), day(0)))
		const id = requested.state.vacations[0]?.id ?? ""
		expect(
			requested.outbox
				.find((m) => m.chatId === chatOf(B))
				?.keyboard.flat()
				.map((b) => b.text),
		).toEqual(["✅ Genehmigen", "❌ Ablehnen"])
		expect(fail(approveVacation(requested.state, A, id, day(0))).reason).toContain("eigenen Urlaub")
		// Pending vacations don't change anything yet.
		expect(responsibleOn(requested.state, task(requested.state), day(2))).toEqual([A])
	})

	test("approved vacation defers the vacationer's tasks to the others, without jokers", () => {
		const state = requestAndApprove(household(spec({ firstDue: day(2) })), 1, 3)
		expect(responsibleOn(state, task(state), day(2))).toEqual([B])
		expect(state.jokers).toHaveLength(0)
		const projected = projectTask(state, task(state), day(8)).map((o) => [o.date, o.responsible[0]])
		expect(projected).toEqual([
			[day(2), B],
			[day(4), B],
			[day(6), A],
			[day(8), B],
		])
	})

	test("a substitute who misses gets punished, not the vacationer", () => {
		const state = requestAndApprove(household(spec({ firstDue: day(2) })), 1, 3)
		const next = rolloverDay(state, day(3)).state
		expect(task(next).current.assignee).toBe(B)
		expect(next.jokers.map((j) => [j.holder, j.debtor])).toEqual([[A, B]])
	})

	test("joint tasks are postponed until everybody is back", () => {
		let state = requestAndApprove(household(spec({ kind: "joint", firstDue: day(2) })), 1, 4)
		for (const d of [1, 2, 3, 4, 5]) {
			state = rolloverDay(state, day(d)).state
		}
		expect(task(state).current.dueDate).toBe(day(5))
		expect(task(state).current.misses).toBe(0)
	})

	test("can be rejected or cancelled", () => {
		const state = household(spec())
		const requested = run(requestVacation(state, A, day(1), day(5), day(0))).state
		const id = requested.vacations[0]?.id ?? ""
		expect(run(rejectVacation(requested, B, id, day(0))).state.vacations).toHaveLength(0)
		const approved = requestAndApprove(state, 1, 5)
		expect(
			fail(cancelVacation(approved, B, approved.vacations[0]?.id ?? "", day(0))).reason,
		).toContain("Nur wer")
		const cancelled = run(
			cancelVacation(approved, A, approved.vacations[0]?.id ?? "", day(0)),
		).state
		expect(responsibleOn(cancelled, task(cancelled), day(2))).toEqual([A])
	})

	test("rejects nonsense", () => {
		const state = household(spec())
		expect(fail(requestVacation(state, A, day(-1), day(2), day(0))).reason).toContain(
			"Vergangenheit",
		)
		expect(fail(requestVacation(state, A, day(3), day(2), day(0))).reason).toContain("Ende")
		const approved = requestAndApprove(state, 1, 5)
		expect(fail(requestVacation(approved, A, day(5), day(7), day(0))).reason).toContain(
			"überschneidet",
		)
	})

	test("expired vacations are cleaned up", () => {
		let state = requestAndApprove(household(spec()), 1, 2)
		state = rolloverDay(state, day(3)).state
		expect(state.vacations).toHaveLength(0)
	})
})
