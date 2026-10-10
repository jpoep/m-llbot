import { describe, expect, test } from "bun:test"
import { Option } from "effect"
import { approveReschedule, complete, requestReschedule } from "../src/domain/actions.ts"
import { cadence } from "../src/domain/cadence.ts"
import { decodeCallback, encodeCallback } from "../src/domain/callbacks.ts"
import { doneConfirm, doneOtherPicker, donePicker } from "../src/domain/views.ts"
import { A, B, day, household, run, spec, task, textsTo } from "./helpers.ts"

const tags = (keyboard: ReadonlyArray<ReadonlyArray<{ data: string }>>): ReadonlyArray<string> =>
	keyboard.flat().map((b) => Option.getOrThrow(decodeCallback(b.data))._tag)

describe("checking off a task off-schedule", () => {
	test("a joint task done months early restarts its yearly rhythm", () => {
		const state = household(
			spec({ name: "Fenster", kind: "joint", cadence: cadence(1, "year"), firstDue: day(60) }),
		)
		const t = task(state)
		const result = run(complete(state, B, t.id, t.current.index, day(1)))
		expect(task(result.state).current.dueDate).toBe(day(366))
		expect(textsTo(result.outbox, A).join()).toContain("Rhythmus zählt jetzt ab")
	})

	test("completing on an approved reschedule date keeps the original rhythm", () => {
		let state = household(spec({ cadence: cadence(3, "day"), firstDue: day(3) }))
		const t = task(state)
		state = run(requestReschedule(state, A, t.id, t.current.index, day(4), day(1))).state
		state = run(approveReschedule(state, B, state.reschedules[0]?.id ?? "", day(1))).state
		state = run(complete(state, A, t.id, t.current.index, day(4))).state
		expect(task(state).current.dueDate).toBe(day(6))
	})

	test("the picker: own task due today is one tap, early or foreign ones ask first", () => {
		const state = household(
			spec({ name: "Heute", firstDue: day(0) }),
			spec({ name: "Später", firstDue: day(3) }),
			spec({ name: "Fremd", firstDue: day(1) }),
		)
		// rotation: task 0 → A, task 1 → B, task 2 → A
		expect(tags(donePicker(state, A, day(0)).keyboard)).toEqual(["Done", "DoneAsk", "DoneOther"])
		const other = doneOtherPicker(state, A, day(0))
		expect(other.keyboard.flat().map((b) => b.text)).toEqual([
			"Später (übermorgen, Ben)".replace("übermorgen", "Do, 15.10."),
		])
		expect(tags(other.keyboard)).toEqual(["DoneAsk"])
	})

	test("the confirmation explains the consequences", () => {
		const state = household(spec({ cadence: cadence(3, "day"), firstDue: day(2) }))
		const foreign = doneConfirm(state, task(state), B, day(1))
		expect(foreign.text).toContain("Eigentlich ist Anna")
		expect(foreign.text).toContain("Rhythmus ab heute")
		expect(foreign.text).toContain("Nächstes Mal wäre dann Fr, 16.10.")
		expect(foreign.text).not.toContain("(Fr, 16.10.)")
		expect(tags(foreign.keyboard)).toEqual(["DoneConfirm", "Dismiss"])
	})

	test("new callbacks round-trip", () => {
		for (const action of [
			{ _tag: "DoneOther" } as const,
			{ _tag: "DoneAsk", taskId: "t3", index: 4 } as const,
			{ _tag: "DoneConfirm", taskId: "t3", index: 4 } as const,
		]) {
			expect(decodeCallback(encodeCallback(action))).toEqual(Option.some(action))
		}
	})
})
