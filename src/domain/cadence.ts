import { Option, Schema } from "effect"
import { addDays, addMonths, type LocalDate } from "./calendar.ts"

export const CadenceUnit = Schema.Literals(["day", "week", "month", "year"])
export type CadenceUnit = typeof CadenceUnit.Type

export const Cadence = Schema.Struct({
	unit: CadenceUnit,
	every: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
})
export type Cadence = typeof Cadence.Type

export const cadence = (every: number, unit: CadenceUnit): Cadence => ({ every, unit })

/**
 * The `index`-th date of the grid that starts at `anchor`. Month and year cadences are computed
 * from the anchor (not iteratively) so that clamping at month ends never drifts.
 */
export const nthDate = (anchor: LocalDate, { unit, every }: Cadence, index: number): LocalDate => {
	switch (unit) {
		case "day":
			return addDays(anchor, every * index)
		case "week":
			return addDays(anchor, 7 * every * index)
		case "month":
			return addMonths(anchor, every * index)
		case "year":
			return addMonths(anchor, 12 * every * index)
	}
}

const UNIT_NAMES: Record<CadenceUnit, readonly [singular: string, plural: string]> = {
	day: ["Tag", "Tage"],
	week: ["Woche", "Wochen"],
	month: ["Monat", "Monate"],
	year: ["Jahr", "Jahre"],
}

const ADVERBS: Record<CadenceUnit, string> = {
	day: "täglich",
	week: "wöchentlich",
	month: "monatlich",
	year: "jährlich",
}

export const formatCadence = ({ unit, every }: Cadence): string =>
	every === 1 ? ADVERBS[unit] : `alle ${every} ${UNIT_NAMES[unit][1]}`

const UNIT_ALIASES: ReadonlyArray<readonly [RegExp, CadenceUnit]> = [
	[/^(d|t|tag|tage|tagen)$/, "day"],
	[/^(w|wo|woche|wochen)$/, "week"],
	[/^(m|monat|monate|monaten)$/, "month"],
	[/^(j|y|jahr|jahre|jahren)$/, "year"],
]

/**
 * Parses German cadence descriptions like `täglich`, `wöchentlich`, `3 Tage`, `alle 2 Wochen`,
 * `jedes Jahr`, `2w` or a bare number of days (`3`).
 */
export const parseCadence = (input: string): Option.Option<Cadence> => {
	const text = input
		.trim()
		.toLowerCase()
		.replace(/^(alle|jede[nrs]?)\s+/, "")
	for (const [unit, adverb] of Object.entries(ADVERBS) as Array<[CadenceUnit, string]>) {
		if (text === adverb) {
			return Option.some(cadence(1, unit))
		}
	}
	const match = /^(\d+)?\s*([a-zäöü]*)$/.exec(text)
	if (!match) {
		return Option.none()
	}
	const every = match[1] === undefined ? 1 : Number(match[1])
	const unitText = match[2] ?? ""
	if (every < 1 || every > 1000 || (match[1] === undefined && unitText === "")) {
		return Option.none()
	}
	if (unitText === "") {
		return Option.some(cadence(every, "day"))
	}
	const unit = UNIT_ALIASES.find(([pattern]) => pattern.test(unitText))?.[1]
	return unit === undefined ? Option.none() : Option.some(cadence(every, unit))
}
