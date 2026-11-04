import { describe, expect, test } from "bun:test"
import { Option, Schema } from "effect"
import { complete, deleteTask, giftToken, redeemToken } from "../src/domain/actions.ts"
import { cadence } from "../src/domain/cadence.ts"
import { decodeCallback, encodeCallback } from "../src/domain/callbacks.ts"
import { Token } from "../src/domain/model.ts"
import { responsibleOn } from "../src/domain/schedule.ts"
import { rolloverDay } from "../src/domain/tick.ts"
import { giftConfirm, giftRecipientPicker, tokenView } from "../src/domain/views.ts"
import {
	A,
	at,
	B,
	C,
	day,
	fail,
	household,
	run,
	spec,
	task,
	textsTo,
	withPeople,
} from "./helpers.ts"

const EMOJI = /\p{Extended_Pictographic}/u

describe("tokens are wildcards", () => {
	test("a token earned on one task can be redeemed on another", () => {
		// Trash (task 0) starts with A on day 1; vacuuming (task 1) starts with B on day 3.
		let state = household(
			spec({ firstDue: day(1), cadence: cadence(7, "day") }),
			spec({ name: "Saugen", firstDue: day(3), cadence: cadence(7, "day") }),
		)
		state = rolloverDay(state, day(2)).state // A missed the trash → B holds a token against A
		expect(state.tokens.map((t) => [t.holder, t.debtor])).toEqual([[B, A]])
		const vacuum = task(state, 1)
		const redeemed = run(redeemToken(state, B, vacuum.id, vacuum.current.index, at(3, 9)))
		expect(responsibleOn(redeemed.state, task(redeemed.state, 1), day(3))).toEqual([A])
		expect(redeemed.state.tokens).toHaveLength(0)
	})

	test("still not for joint tasks", () => {
		let state = household(
			spec({ firstDue: day(1) }),
			spec({ name: "Fenster", kind: "joint", firstDue: day(3) }),
		)
		state = rolloverDay(state, day(2)).state
		const joint = task(state, 1)
		expect(fail(redeemToken(state, B, joint.id, joint.current.index, at(3, 9))).reason).toContain(
			"gemeinsamen",
		)
	})

	test("deleting a task keeps the tokens", () => {
		let state = household(spec({ firstDue: day(1) }), spec({ name: "Saugen" }))
		state = rolloverDay(state, day(2)).state
		state = run(deleteTask(state, A, task(state, 0).id)).state
		expect(state.tokens).toHaveLength(1)
	})

	test("tokens stored with a task reference load as wildcards", () => {
		const old = { id: "j3", taskId: "t1", holder: A, debtor: B, earnedOn: day(0) }
		const decoded = Schema.decodeUnknownSync(Token)(old)
		expect(decoded).toEqual({ id: "j3", holder: A, debtor: B, earnedOn: day(0), source: "missed" })
	})
})

describe("gifting tokens", () => {
	test("the recipient gets a token against the giver and can push any turn onto them", () => {
		// Every 2 days: A on day 2, B on day 4.
		let state = household(spec({ firstDue: day(2) }))
		const t = task(state)
		const gift = run(giftToken(state, A, B, day(1)))
		expect(gift.state.tokens).toEqual([
			{ id: expect.any(String), holder: B, debtor: A, earnedOn: day(1), source: "gift" },
		])
		expect(textsTo(gift.outbox, B).join()).toContain("schenkt dir ein Token")
		expect(textsTo(gift.outbox, A).join()).toContain("egal welche")

		state = run(complete(gift.state, A, t.id, t.current.index, day(2))).state
		const redeemed = run(redeemToken(state, B, t.id, task(state).current.index, at(3, 9)))
		expect(responsibleOn(redeemed.state, task(redeemed.state), day(4))).toEqual([A])
		expect(textsTo(redeemed.outbox, A).join()).toContain("selbst verschenkt")
		const texts = [...redeemed.outbox, ...gift.outbox].map((m) => m.text)
		expect(texts.filter((x) => EMOJI.test(x))).toEqual([])
	})

	test("refuses self-gifts and strangers", () => {
		const state = household(spec())
		expect(fail(giftToken(state, A, A, day(0))).reason).toContain("Sich selbst")
		expect(fail(giftToken(state, A, C, day(0))).reason).toContain("nicht (mehr)")
	})

	test("pickers: straight to the confirmation with one roommate, recipient first with more", () => {
		const two = household(spec())
		const direct = giftRecipientPicker(two, A)
		expect(direct.text).toContain("Zurücknehmen geht nicht")
		expect(direct.keyboard.flat().map((b) => b.text)).toEqual(["Verschenken", "Abbrechen"])

		const three = withPeople(two, C)
		expect(
			giftRecipientPicker(three, A)
				.keyboard.flat()
				.map((b) => b.text),
		).toEqual(["Ben", "Cleo"])
		expect(giftConfirm(three, C).text).toContain("Cleo")
	})

	test("the token view always offers gifting and labels where tokens came from", () => {
		const state = household(spec())
		expect(
			tokenView(state, B, at(0, 9))
				.keyboard.flat()
				.map((b) => b.text),
		).toEqual(["Token verschenken"])
		const gifted = run(giftToken(state, A, B, day(0))).state
		const v = tokenView(gifted, B, at(0, 9))
		expect(v.text).toContain("geschenkt am")
		expect(v.text).toContain("jede Aufgabe")
	})

	test("callbacks round-trip with real Telegram ids", () => {
		for (const action of [
			{ _tag: "TokenGiftStart" as const },
			{ _tag: "TokenGiftRecipient" as const, recipient: 195126083 },
			{ _tag: "TokenGiftConfirm" as const, recipient: 195126083 },
		]) {
			expect(decodeCallback(encodeCallback(action))).toEqual(Option.some(action))
		}
		expect(decodeCallback("gk:abc")).toEqual(Option.none())
		expect(decodeCallback("gc:195126083:t1")).toEqual(Option.none()) // pre-wildcard gift buttons
	})
})
