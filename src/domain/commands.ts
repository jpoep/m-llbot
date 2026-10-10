import { Effect, Option } from "effect"
import { settings } from "../settings.ts"
import { type NewTask, Rejected } from "./actions.ts"
import { clampLevel } from "./annoyance.ts"
import { type Cadence, parseCadence } from "./cadence.ts"
import { addDays, type LocalDate, parseDate } from "./calendar.ts"
import type { State, Task, TaskKind } from "./model.ts"

const reject = (reason: string): Effect.Effect<never, Rejected> =>
	Effect.fail(new Rejected({ reason }))

const splitArgs = (args: string): ReadonlyArray<string> =>
	args
		.split("|")
		.map((part) => part.trim())
		.filter((part) => part.length > 0)

const requireCadence = (text: string | undefined): Effect.Effect<Cadence, Rejected> =>
	Option.match(Option.flatMap(Option.fromUndefinedOr(text), parseCadence), {
		onNone: () =>
			reject(
				"Den Rhythmus verstehe ich nicht. Beispiele: <code>täglich</code>, <code>alle 3 Tage</code>, <code>2 Wochen</code>, <code>monatlich</code>, <code>jährlich</code>.",
			),
		onSome: Effect.succeed,
	})

const requireDate = (text: string, today: LocalDate): Effect.Effect<LocalDate, Rejected> =>
	Option.match(parseDate(text, today), {
		onNone: () =>
			reject(
				`„${text}“ ist kein Datum, das ich kenne. Beispiele: <code>morgen</code>, <code>13.10.</code>, <code>2026-10-13</code>.`,
			),
		onSome: Effect.succeed,
	})

/** `/neu [Emoji] Name | Rhythmus [| gemeinsam] [| ab Datum]` */
export const parseNewTask = (args: string, today: LocalDate): Effect.Effect<NewTask, Rejected> =>
	Effect.gen(function* () {
		const [rawName, rawCadence, ...options] = splitArgs(args)
		if (rawName === undefined || rawCadence === undefined) {
			return yield* reject(
				"So geht's: <code>/neu Pflanzen gießen | alle 3 Tage</code>\nOptional: <code>| gemeinsam</code> und <code>| ab 01.11.</code>",
			)
		}
		const name = rawName
		const cadence = yield* requireCadence(rawCadence)
		let kind: TaskKind = "rotating"
		let firstDue = addDays(today, 1)
		for (const option of options) {
			const lower = option.toLowerCase()
			if (lower === "gemeinsam" || lower === "zusammen") {
				kind = "joint"
			} else {
				firstDue = yield* requireDate(lower.replace(/^ab\s+/, ""), today)
			}
		}
		return { name, cadence, kind, firstDue, annoyance: settings.defaultAnnoyance }
	})

/** Resolves a task by its number in `/aufgaben` or by (the start of) its name. */
export const resolveTask = (state: State, ref: string): Effect.Effect<Task, Rejected> => {
	const trimmed = ref.trim().toLowerCase()
	const byNumber = /^\d+$/.test(trimmed) ? state.tasks[Number(trimmed) - 1] : undefined
	const byName = state.tasks.filter((t) => t.name.toLowerCase().startsWith(trimmed))
	const task = byNumber ?? (byName.length === 1 ? byName[0] : undefined)
	return task === undefined
		? reject(`Welche Aufgabe meinst du mit „${trimmed}“? Nummern stehen in /aufgaben.`)
		: Effect.succeed(task)
}

const taskAndValue = (
	state: State,
	args: string,
	usage: string,
): Effect.Effect<[Task, string], Rejected> =>
	Effect.gen(function* () {
		const [ref, value] = splitArgs(args)
		if (ref === undefined || value === undefined) {
			return yield* reject(usage)
		}
		return [yield* resolveTask(state, ref), value] as [Task, string]
	})

/** `/rhythmus Nr | Rhythmus` */
export const parseCadenceChange = (
	state: State,
	args: string,
): Effect.Effect<[Task, Cadence], Rejected> =>
	Effect.flatMap(
		taskAndValue(state, args, "So geht's: <code>/rhythmus 1 | alle 4 Tage</code>"),
		([task, value]) => Effect.map(requireCadence(value), (c) => [task, c] as [Task, Cadence]),
	)

/** `/termin Nr | Datum` */
export const parseDateChange = (
	state: State,
	args: string,
	today: LocalDate,
): Effect.Effect<[Task, LocalDate], Rejected> =>
	Effect.flatMap(
		taskAndValue(
			state,
			args,
			"So geht's: <code>/termin 1 | morgen</code> oder <code>/termin 2 | 24.10.</code>",
		),
		([task, value]) => Effect.map(requireDate(value, today), (d) => [task, d] as [Task, LocalDate]),
	)

/** `/verschieben Nr | Datum` */
export const parseRescheduleArgs = (
	state: State,
	args: string,
	today: LocalDate,
): Effect.Effect<[Task, LocalDate], Rejected> =>
	Effect.flatMap(
		taskAndValue(
			state,
			args,
			"So geht's: <code>/verschieben 1 | morgen</code> oder <code>/verschieben 2 | Sa</code>. Ohne Angaben gibt es Knöpfe.",
		),
		([task, value]) => Effect.map(requireDate(value, today), (d) => [task, d] as [Task, LocalDate]),
	)

/** `/urlaub 20.12. 03.01.` (also `20.12. - 03.01.` or `20.12. bis 03.01.`) */
export const parseVacation = (
	args: string,
	today: LocalDate,
): Effect.Effect<[from: LocalDate, to: LocalDate], Rejected> =>
	Effect.gen(function* () {
		const parts = args
			.replace(/\s+(bis|-|–)\s+/gi, " ")
			.trim()
			.split(/\s+/)
			.filter((p) => p.length > 0)
		const [fromText, toText] = parts
		if (fromText === undefined || parts.length > 2) {
			return yield* reject(
				"So geht's: <code>/urlaub 20.12. 03.01.</code> (ein Tag: <code>/urlaub 24.12.</code>)",
			)
		}
		const from = yield* requireDate(fromText, today)
		const to = toText === undefined ? from : yield* requireDate(toText, from)
		return [from, to] as [LocalDate, LocalDate]
	})

/** `/vorschau 7` */
export const parseLevel = (args: string): Effect.Effect<number, Rejected> => {
	const trimmed = args.trim()
	return /^\d{1,2}$/.test(trimmed) && Number(trimmed) <= 10
		? Effect.succeed(clampLevel(Number(trimmed)))
		: reject("So geht's: <code>/vorschau 5</code> (Stufe 0 bis 10)")
}
