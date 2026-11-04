import { describe, expect, test } from "bun:test"
import { Option, Schema } from "effect"
import { complete, giftToken, redeemToken } from "../src/domain/actions.ts"
import { decodeCallback, encodeCallback } from "../src/domain/callbacks.ts"
import { Token } from "../src/domain/model.ts"
import { responsibleOn } from "../src/domain/schedule.ts"
import { giftConfirm, giftRecipientPicker, giftTaskPicker, tokenView } from "../src/domain/views.ts"
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

describe("gifting tokens", () => {
	test("the recipient gets a token against the giver and can push a turn onto them", () => {
		// Every 2 days: A on day 2, B on day 4.
		let state = household(spec({ firstDue: day(2) }))
		const t = task(state)
		const gift = run(giftToken(state, A, B, t.id, day(1)))
		expect(gift.state.tokens).toEqual([
			{
				id: expect.any(String),
				taskId: t.id,
				holder: B,
				debtor: A,
				earnedOn: day(1),
				source: "gift",
			},
		])
		expect(textsTo(gift.outbox, B).join()).toContain("schenkt dir ein Token")
		expect(textsTo(gift.outbox, A).join()).toContain("Verschenkt")

		state = run(complete(gift.state, A, t.id, t.current.index, day(2))).state
		const redeemed = run(redeemToken(state, B, t.id, task(state).current.index, at(3, 9)))
		expect(responsibleOn(redeemed.state, task(redeemed.state), day(4))).toEqual([A])
		expect(textsTo(redeemed.outbox, A).join()).toContain("selbst verschenkt")
		expect(
			[...redeemed.outbox.map((m) => m.text), ...gift.outbox.map((m) => m.text)].some((x) =>
				EMOJI.test(x),
			),
		).toBe(false)
	})

	test("refuses self-gifts, joint tasks and strangers", () => {
		const state = household(spec(), spec({ name: "Fenster", kind: "joint" }))
		expect(fail(giftToken(state, A, A, task(state).id, day(0))).reason).toContain("Sich selbst")
		expect(fail(giftToken(state, A, B, task(state, 1).id, day(0))).reason).toContain("gemeinsamen")
		expect(fail(giftToken(state, A, C, task(state).id, day(0))).reason).toContain("nicht (mehr)")
	})

	test("pickers: straight to the task list with one roommate, recipient first with more", () => {
		const two = household(spec(), spec({ name: "Fenster", kind: "joint" }))
		const direct = giftRecipientPicker(two, A)
		expect(direct.text).toContain("Ben")
		expect(direct.keyboard.flat().map((b) => b.text)).toEqual(["Müll runterbringen", "Abbrechen"])

		const three = withPeople(two, C)
		const names = giftRecipientPicker(three, A)
			.keyboard.flat()
			.map((b) => b.text)
		expect(names).toEqual(["Ben", "Cleo"])
		expect(giftTaskPicker(three, C).text).toContain("Cleo")
		expect(giftConfirm(three, C, task(three)).text).toContain("Zurücknehmen geht nicht")
	})

	test("the token view always offers gifting and labels gifted tokens", () => {
		const state = household(spec())
		expect(
			tokenView(state, B, at(0, 9))
				.keyboard.flat()
				.map((b) => b.text),
		).toEqual(["Token verschenken"])
		const gifted = run(giftToken(state, A, B, task(state).id, day(0))).state
		expect(tokenView(gifted, B, at(0, 9)).text).toContain("geschenkt am")
	})

	test("callbacks round-trip with real Telegram ids", () => {
		for (const action of [
			{ _tag: "TokenGiftStart" } as const,
			{ _tag: "TokenGiftRecipient", recipient: 195126083 } as const,
			{ _tag: "TokenGiftTask", recipient: 195126083, taskId: "t12" } as const,
			{ _tag: "TokenGiftConfirm", recipient: 195126083, taskId: "t12" } as const,
		]) {
			expect(decodeCallback(encodeCallback(action))).toEqual(Option.some(action))
		}
		expect(decodeCallback("gc:abc:t1")).toEqual(Option.none())
	})

	test("tokens stored before gifting existed count as earned by a miss", () => {
		const old = { id: "j3", taskId: "t1", holder: A, debtor: B, earnedOn: day(0) }
		expect(Schema.decodeUnknownSync(Token)(old).source).toBe("missed")
	})
})
