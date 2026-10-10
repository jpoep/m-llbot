/**
 * Prints the exact evening reminder cadence for one or all annoyance levels.
 *   bun run preview        # all levels
 *   bun run preview 6      # just level 6
 */
import { formatPreview, MAX_ANNOYANCE, MIN_ANNOYANCE } from "../src/domain/annoyance.ts"

const toPlain = (html: string): string => html.replace(/<[^>]+>/g, "")

const arg = process.argv[2]
const levels =
	arg === undefined
		? Array.from({ length: MAX_ANNOYANCE - MIN_ANNOYANCE + 1 }, (_, i) => MIN_ANNOYANCE + i)
		: [Number(arg)]

for (const level of levels) {
	if (!Number.isInteger(level) || level < MIN_ANNOYANCE || level > MAX_ANNOYANCE) {
		console.error(`Level must be an integer between ${MIN_ANNOYANCE} and ${MAX_ANNOYANCE}`)
		process.exit(1)
	}
	console.log(`${toPlain(formatPreview(level))}\n`)
}
