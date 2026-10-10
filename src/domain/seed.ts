import { createTask, type NewTask } from "./actions.ts"
import { cadence } from "./cadence.ts"
import { addDays, type LocalDate, LocalDate as LocalDateSchema } from "./calendar.ts"
import type { State } from "./model.ts"

const nextSpring = (today: LocalDate): LocalDate => {
	const year = Number(today.slice(0, 4))
	const thisYear = LocalDateSchema.make(`${year}-04-15`)
	return thisYear >= today ? thisYear : LocalDateSchema.make(`${year + 1}-04-15`)
}

export const defaultTasks = (today: LocalDate): ReadonlyArray<NewTask> => [
	{
		name: "Müll runterbringen",
		cadence: cadence(3, "day"),
		kind: "rotating",
		firstDue: addDays(today, 1),
		annoyance: 4,
	},
	{
		name: "Bad putzen",
		cadence: cadence(2, "week"),
		kind: "rotating",
		firstDue: addDays(today, 5),
		annoyance: 3,
	},
	{
		name: "Flur, Küche, Wohnzimmer saugen",
		cadence: cadence(1, "week"),
		kind: "rotating",
		firstDue: addDays(today, 2),
		annoyance: 3,
	},
	{
		name: "Hausflur saugen",
		cadence: cadence(1, "year"),
		kind: "joint",
		firstDue: addDays(today, 21),
		annoyance: 2,
	},
	{
		name: "Fenster putzen",
		cadence: cadence(1, "year"),
		kind: "joint",
		firstDue: nextSpring(today),
		annoyance: 2,
	},
]

export const emptyState: State = {
	participants: [],
	tasks: [],
	tokens: [],
	vacations: [],
	reschedules: [],
	lastRollover: null,
	lastDigest: null,
	nextId: 1,
}

export const initialState = (today: LocalDate): State =>
	defaultTasks(today).reduce((state, spec) => createTask(state, spec)[1], emptyState)
