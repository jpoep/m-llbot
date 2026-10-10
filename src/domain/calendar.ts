import { DateTime, Option, Schema } from "effect"

/** A calendar date without time or zone, ISO formatted (`YYYY-MM-DD`). */
export const LocalDate = Schema.String.pipe(
	Schema.check(Schema.isPattern(/^\d{4}-\d{2}-\d{2}$/)),
	Schema.brand("LocalDate"),
)
export type LocalDate = typeof LocalDate.Type

/** A wall-clock moment in the household's time zone: a date plus minutes after midnight. */
export interface LocalMoment {
	readonly date: LocalDate
	readonly minute: number
}

const MS_PER_DAY = 86_400_000
const MINUTES_PER_DAY = 24 * 60

const pad = (value: number, width = 2): string => String(value).padStart(width, "0")

const fromParts = (year: number, month: number, day: number): LocalDate =>
	LocalDate.make(`${pad(year, 4)}-${pad(month)}-${pad(day)}`)

const parts = (date: LocalDate): readonly [year: number, month: number, day: number] => {
	const [year = 0, month = 1, day = 1] = date.split("-").map(Number)
	return [year, month, day]
}

export const toEpochDay = (date: LocalDate): number => {
	const [year, month, day] = parts(date)
	return Date.UTC(year, month - 1, day) / MS_PER_DAY
}

export const fromEpochDay = (epochDay: number): LocalDate => {
	const d = new Date(epochDay * MS_PER_DAY)
	return fromParts(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate())
}

export const addDays = (date: LocalDate, days: number): LocalDate =>
	fromEpochDay(toEpochDay(date) + days)

const daysInMonth = (year: number, month: number): number =>
	new Date(Date.UTC(year, month, 0)).getUTCDate()

/** Adds calendar months, clamping to the last day of the month (Jan 31 + 1 month = Feb 28/29). */
export const addMonths = (date: LocalDate, months: number): LocalDate => {
	const [year, month, day] = parts(date)
	const zeroBased = year * 12 + (month - 1) + months
	const targetYear = Math.floor(zeroBased / 12)
	const targetMonth = (zeroBased % 12) + 1
	return fromParts(targetYear, targetMonth, Math.min(day, daysInMonth(targetYear, targetMonth)))
}

/** Number of days from `from` to `to` (positive if `to` is later). */
export const daysBetween = (from: LocalDate, to: LocalDate): number =>
	toEpochDay(to) - toEpochDay(from)

export const isBefore = (a: LocalDate, b: LocalDate): boolean => a < b

export const isWithin = (date: LocalDate, from: LocalDate, to: LocalDate): boolean =>
	from <= date && date <= to

export const compareMoments = (a: LocalMoment, b: LocalMoment): number =>
	a.date === b.date ? a.minute - b.minute : a.date.localeCompare(b.date)

/** 0 = Monday … 6 = Sunday. */
export const weekdayIndex = (date: LocalDate): number => (toEpochDay(date) + 3) % 7

export const momentFromEpochMillis = (epochMillis: number, timeZone: string): LocalMoment => {
	const zoned = DateTime.makeZonedUnsafe(epochMillis, { timeZone })
	const p = DateTime.toParts(zoned)
	return { date: fromParts(p.year, p.month, p.day), minute: p.hour * 60 + p.minute }
}

export const minutesUntilMidnight = (minute: number): number => MINUTES_PER_DAY - minute

// ---------------------------------------------------------------------------
// German formatting & parsing
// ---------------------------------------------------------------------------

const WEEKDAYS = ["Mo", "Di", "Mi", "Do", "Fr", "Sa", "So"] as const

export const formatMinute = (minute: number): string =>
	`${pad(Math.floor(minute / 60))}:${pad(minute % 60)}`

/** `Mo, 13.10.` – or `Mo, 13.10.2027` if the year differs from `relativeTo`. */
export const formatDate = (date: LocalDate, relativeTo?: LocalDate): string => {
	const [year, month, day] = parts(date)
	const sameYear = relativeTo === undefined || parts(relativeTo)[0] === year
	return `${WEEKDAYS[weekdayIndex(date)]}, ${pad(day)}.${pad(month)}.${sameYear ? "" : year}`
}

/** `heute`, `morgen`, `übermorgen` or a formatted date. */
export const formatRelativeDate = (date: LocalDate, today: LocalDate): string => {
	switch (daysBetween(today, date)) {
		case -1:
			return "gestern"
		case 0:
			return "heute"
		case 1:
			return "morgen"
		case 2:
			return "übermorgen"
		default:
			return formatDate(date, today)
	}
}

const isValidDate = (year: number, month: number, day: number): boolean =>
	month >= 1 && month <= 12 && day >= 1 && day <= daysInMonth(year, month)

/**
 * Parses `heute`, `morgen`, `übermorgen`, `13.10.`, `13.10.2026`, `13.10.26` and `2026-10-13`.
 * Dates without a year resolve to the next occurrence on or after `today`.
 */
export const parseDate = (input: string, today: LocalDate): Option.Option<LocalDate> => {
	const text = input.trim().toLowerCase()
	const keywords: Record<string, number> = { heute: 0, morgen: 1, übermorgen: 2 }
	const offset = keywords[text]
	if (offset !== undefined) {
		return Option.some(addDays(today, offset))
	}

	const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text)
	if (iso) {
		const [year, month, day] = [Number(iso[1]), Number(iso[2]), Number(iso[3])]
		return isValidDate(year, month, day) ? Option.some(fromParts(year, month, day)) : Option.none()
	}

	const german = /^(\d{1,2})\.(\d{1,2})\.(\d{2}|\d{4})?$/.exec(text)
	if (!german) {
		return Option.none()
	}
	const day = Number(german[1])
	const month = Number(german[2])
	const rawYear = german[3]
	if (rawYear !== undefined) {
		const year = rawYear.length === 2 ? 2000 + Number(rawYear) : Number(rawYear)
		return isValidDate(year, month, day) ? Option.some(fromParts(year, month, day)) : Option.none()
	}
	const [thisYear] = parts(today)
	for (const year of [thisYear, thisYear + 1]) {
		if (isValidDate(year, month, day) && fromParts(year, month, day) >= today) {
			return Option.some(fromParts(year, month, day))
		}
	}
	return Option.none()
}
