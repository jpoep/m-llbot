import { Array as Arr, Schema } from "effect"
import { settings } from "../settings.ts"
import { formatMinute } from "./calendar.ts"

export const MIN_ANNOYANCE = 0
export const MAX_ANNOYANCE = 10

/** 0 = only the morning digest, 10 = maximum psychological warfare. */
export const Annoyance = Schema.Int.check(
	Schema.isBetween({ minimum: MIN_ANNOYANCE, maximum: MAX_ANNOYANCE }),
)
export type Annoyance = typeof Annoyance.Type

const MIDNIGHT = 24 * 60
/** Fraction of the remaining time until midnight that level 1 waits between two reminders. */
const GENTLEST_FRACTION = 0.75
/** Fraction of the remaining time until midnight that level 10 waits between two reminders. */
const HARSHEST_FRACTION = 0.04
/** Every level ends with one message per minute for at least this many minutes. */
const FINAL_COUNTDOWN_MINUTES = 3

/**
 * The core of the escalation: after each reminder we wait a fixed fraction of the time that is left
 * until midnight. That yields gaps of a few hours in the early evening which shrink geometrically
 * until they hit the one-minute floor right before midnight. The fraction is interpolated
 * logarithmically between {@link GENTLEST_FRACTION} (level 1) and {@link HARSHEST_FRACTION} (level 10).
 * Gentle levels would jump over the last minutes, so every level ends with a
 * {@link FINAL_COUNTDOWN_MINUTES}-minute countdown.
 */
export const waitFraction = (level: number): number =>
	GENTLEST_FRACTION *
	(HARSHEST_FRACTION / GENTLEST_FRACTION) ** ((clampLevel(level) - 1) / (MAX_ANNOYANCE - 1))

export const clampLevel = (level: number): number =>
	Math.min(MAX_ANNOYANCE, Math.max(MIN_ANNOYANCE, Math.round(level)))

/** The annoyance an occurrence actually uses: every missed day turns the dial up. */
export const effectiveAnnoyance = (level: number, misses: number): number =>
	level === MIN_ANNOYANCE
		? clampLevel(misses * settings.annoyanceBoostPerMiss)
		: clampLevel(level + misses * settings.annoyanceBoostPerMiss)

/**
 * All local minutes-after-midnight at which an evening reminder is sent for the given level.
 * The first reminder is always at `startMinute`; the last one is at 23:59 at the latest.
 */
export const reminderMinutes = (
	level: number,
	startMinute: number = settings.eveningStartMinute,
): ReadonlyArray<number> => {
	if (clampLevel(level) === MIN_ANNOYANCE) {
		return []
	}
	const fraction = waitFraction(level)
	const minutes: Array<number> = []
	const countdownStart = MIDNIGHT - FINAL_COUNTDOWN_MINUTES
	for (let minute = startMinute; minute < MIDNIGHT; ) {
		minutes.push(minute)
		if (minute >= countdownStart) {
			minute++
		} else {
			const next = minute + Math.max(1, Math.round(fraction * (MIDNIGHT - minute)))
			minute = Math.min(next, countdownStart)
		}
	}
	return minutes
}

export interface AnnoyancePreview {
	readonly level: number
	readonly minutes: ReadonlyArray<number>
	readonly perHour: ReadonlyArray<{ readonly hour: number; readonly count: number }>
}

export const preview = (
	level: number,
	startMinute: number = settings.eveningStartMinute,
): AnnoyancePreview => {
	const minutes = reminderMinutes(level, startMinute)
	const firstHour = Math.floor(startMinute / 60)
	const perHour = Arr.makeBy(24 - firstHour, (i) => {
		const hour = firstHour + i
		return { hour, count: minutes.filter((m) => Math.floor(m / 60) === hour).length }
	})
	return { level: clampLevel(level), minutes, perHour }
}

/** Collapses runs of consecutive minutes: `23:41 · 23:50 · 23:55–23:59 (jede Minute)`. */
const formatTimeline = (minutes: ReadonlyArray<number>): string => {
	const runs: Array<[start: number, end: number]> = []
	for (const minute of minutes) {
		const last = runs.at(-1)
		if (last && minute === last[1] + 1) {
			last[1] = minute
		} else {
			runs.push([minute, minute])
		}
	}
	return runs
		.map(([start, end]) => {
			if (end - start >= 2) {
				return `${formatMinute(start)}–${formatMinute(end)} (jede Minute)`
			}
			return start === end ? formatMinute(start) : `${formatMinute(start)} · ${formatMinute(end)}`
		})
		.join(" · ")
}

/** Human-readable (German) preview of what a given level feels like. */
export const formatPreview = (
	level: number,
	startMinute: number = settings.eveningStartMinute,
): string => {
	const p = preview(level, startMinute)
	const header = `<b>Nervigkeit ${p.level}/${MAX_ANNOYANCE}</b>`
	const morning = `${formatMinute(settings.morningDigestMinute)} Uhr: Morgenübersicht`
	if (p.minutes.length === 0) {
		return `${header}\n${morning}\nAbends: nichts. Nur die Morgenübersicht.`
	}
	const maxCount = Math.max(...p.perHour.map((h) => h.count))
	const bars = p.perHour
		.map(({ hour, count }) => {
			const bar = "▇".repeat(Math.ceil((count / maxCount) * 12)) || "·"
			return `<code>${String(hour).padStart(2, "0")} Uhr ${bar} ${count}</code>`
		})
		.join("\n")
	return [
		header,
		morning,
		`Danach ${p.minutes.length} Erinnerungen bis Mitternacht, solange etwas offen ist:`,
		"",
		bars,
		"",
		formatTimeline(p.minutes),
	].join("\n")
}
