import { describe, expect, test } from "bun:test"
import { Option } from "effect"
import {
	clampLevel,
	effectiveAnnoyance,
	formatPreview,
	reminderMinutes,
} from "../src/domain/annoyance.ts"
import { cadence, formatCadence, nthDate, parseCadence } from "../src/domain/cadence.ts"
import { addMonths, LocalDate, momentFromEpochMillis, parseDate } from "../src/domain/calendar.ts"
import { type CallbackAction, decodeCallback, encodeCallback } from "../src/domain/callbacks.ts"
import { parseNewTask, parseVacation } from "../src/domain/commands.ts"
import { day, fail, run } from "./helpers.ts"

const d = (iso: string) => LocalDate.make(iso)

describe("calendar", () => {
	test("month arithmetic clamps without drifting", () => {
		expect(addMonths(d("2026-01-31"), 1)).toBe(d("2026-02-28"))
		expect(addMonths(d("2028-01-31"), 1)).toBe(d("2028-02-29"))
		expect(nthDate(d("2026-01-31"), cadence(1, "month"), 2)).toBe(d("2026-03-31"))
		expect(nthDate(d("2028-02-29"), cadence(1, "year"), 1)).toBe(d("2029-02-28"))
	})

	test("parses German dates relative to today", () => {
		const today = d("2026-10-12")
		expect(parseDate("morgen", today)).toEqual(Option.some(d("2026-10-13")))
		expect(parseDate("24.12.", today)).toEqual(Option.some(d("2026-12-24")))
		expect(parseDate("03.01.", today)).toEqual(Option.some(d("2027-01-03")))
		expect(parseDate("1.2.27", today)).toEqual(Option.some(d("2027-02-01")))
		expect(parseDate("2026-11-05", today)).toEqual(Option.some(d("2026-11-05")))
		expect(parseDate("31.02.", today)).toEqual(Option.none())
		expect(parseDate("bald", today)).toEqual(Option.none())
		// 2026-10-12 is a Monday; weekdays mean the next one after today.
		expect(parseDate("Sa", today)).toEqual(Option.some(d("2026-10-17")))
		expect(parseDate("montag", today)).toEqual(Option.some(d("2026-10-19")))
		expect(parseDate("Di.", today)).toEqual(Option.some(d("2026-10-13")))
	})

	test("resolves local time in Europe/Berlin including DST", () => {
		// 2026-03-29 01:30 UTC = 03:30 CEST (after the spring-forward)
		expect(momentFromEpochMillis(Date.UTC(2026, 2, 29, 1, 30), "Europe/Berlin")).toEqual({
			date: d("2026-03-29"),
			minute: 3 * 60 + 30,
		})
		// 2026-12-31 23:30 UTC = 00:30 on New Year's Day in Berlin
		expect(momentFromEpochMillis(Date.UTC(2026, 11, 31, 23, 30), "Europe/Berlin")).toEqual({
			date: d("2027-01-01"),
			minute: 30,
		})
	})
})

describe("cadence parsing", () => {
	test.each([
		["täglich", cadence(1, "day")],
		["alle 3 Tage", cadence(3, "day")],
		["3", cadence(3, "day")],
		["2 Wochen", cadence(2, "week")],
		["2w", cadence(2, "week")],
		["jede Woche", cadence(1, "week")],
		["monatlich", cadence(1, "month")],
		["jährlich", cadence(1, "year")],
		["jedes Jahr", cadence(1, "year")],
	])("%s", (input, expected) => {
		expect(parseCadence(input)).toEqual(Option.some(expected))
	})

	test("rejects garbage", () => {
		expect(parseCadence("manchmal")).toEqual(Option.none())
		expect(parseCadence("0 Tage")).toEqual(Option.none())
	})

	test("formats German", () => {
		expect(formatCadence(cadence(1, "week"))).toBe("wöchentlich")
		expect(formatCadence(cadence(3, "day"))).toBe("alle 3 Tage")
	})
})

describe("annoyance", () => {
	test("escalates from hours apart to one message per minute before midnight", () => {
		for (let level = 1; level <= 10; level++) {
			const minutes = reminderMinutes(level)
			expect(minutes[0]).toBe(18 * 60)
			expect(minutes.at(-1)).toBe(23 * 60 + 59)
			const gaps = minutes.slice(1).map((m, i) => m - (minutes[i] ?? 0))
			// Gaps never grow.
			expect(gaps.every((gap, i) => i === 0 || gap <= (gaps[i - 1] ?? 0))).toBe(true)
			expect(gaps.at(-1)).toBe(1)
		}
	})

	test("is a monotonic knob", () => {
		const counts = Array.from({ length: 11 }, (_, level) => reminderMinutes(level).length)
		expect(counts[0]).toBe(0)
		expect(counts.every((c, i) => i === 0 || c > (counts[i - 1] ?? 0))).toBe(true)
		expect(reminderMinutes(1)[1]).toBeGreaterThanOrEqual(22 * 60)
	})

	test("misses raise the level, capped at 10", () => {
		expect(effectiveAnnoyance(3, 1)).toBe(5)
		expect(effectiveAnnoyance(9, 3)).toBe(10)
		expect(effectiveAnnoyance(0, 1)).toBe(2)
		expect(clampLevel(42)).toBe(10)
	})

	test("preview shows the count and the exact times", () => {
		const text = formatPreview(5)
		expect(text).toContain(`${reminderMinutes(5).length} Erinnerungen`)
		expect(text).toContain("18:00")
		expect(text).toContain("(jede Minute)")
		expect(formatPreview(0)).toContain("Abends: nichts")
	})
})

describe("callback data", () => {
	const actions: ReadonlyArray<CallbackAction> = [
		{ _tag: "Done", taskId: "t12", index: 345 },
		{ _tag: "TakeOver", taskId: "t1", index: 0 },
		{ _tag: "Token", taskId: "t1", index: 7 },
		{ _tag: "RescheduleStart", taskId: "t1", index: 7 },
		{ _tag: "ReschedulePick", taskId: "t1", index: 7, date: d("2026-12-31") },
		{ _tag: "RescheduleApprove", requestId: "r4" },
		{ _tag: "RescheduleReject", requestId: "r4" },
		{ _tag: "RescheduleCancel", requestId: "r4" },
		{ _tag: "VacationApprove", vacationId: "v3" },
		{ _tag: "VacationReject", vacationId: "v3" },
		{ _tag: "VacationCancel", vacationId: "v3" },
		{ _tag: "AnnoyancePick", taskId: "t2" },
		{ _tag: "AnnoyancePreview", taskId: "t2", level: 10 },
		{ _tag: "AnnoyanceSave", taskId: "t2", level: 0 },
		{ _tag: "DeleteAsk", taskId: "t2" },
		{ _tag: "DeleteConfirm", taskId: "t2" },
		{ _tag: "Dismiss" },
	]
	test.each(actions.map((a) => [a._tag, a] as const))(
		"%s round-trips within 64 bytes",
		(_, action) => {
			const data = encodeCallback(action)
			expect(Buffer.byteLength(data)).toBeLessThanOrEqual(64)
			expect(decodeCallback(data)).toEqual(Option.some(action))
		},
	)

	test("rejects tampered data", () => {
		for (const data of [
			"",
			"zz:t1:1",
			"d:t1",
			"d:t1:x",
			"d:t1:1:2",
			"nv:t1:11",
			"va:../x",
			"rp:t1:1:20261341",
			"rp:t1:1",
		]) {
			expect(decodeCallback(data)).toEqual(Option.none())
		}
	})
})

describe("command parsing", () => {
	test("/neu with all options", () => {
		expect(
			run(parseNewTask("Pflanzen gießen | alle 3 Tage | gemeinsam | ab 20.10.", day(0))),
		).toEqual({
			name: "Pflanzen gießen",
			cadence: cadence(3, "day"),
			kind: "joint",
			firstDue: d("2026-10-20"),
			annoyance: 3,
		})
	})

	test("/neu defaults", () => {
		const spec = run(parseNewTask("Pflanzen gießen | wöchentlich", day(0)))
		expect(spec.kind).toBe("rotating")
		expect(spec.firstDue).toBe(day(1))
		expect(fail(parseNewTask("Pflanzen", day(0))).reason).toContain("So geht's")
	})

	test("/urlaub accepts ranges across the new year", () => {
		expect(run(parseVacation("20.12. bis 03.01.", day(0)))).toEqual([
			d("2026-12-20"),
			d("2027-01-03"),
		])
		expect(run(parseVacation("24.12.", day(0)))).toEqual([d("2026-12-24"), d("2026-12-24")])
	})
})
