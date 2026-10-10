import { Effect } from "effect"
import { settings } from "../settings.ts"
import {
	canStillRedeemToken,
	playableTokens,
	replaceTask,
	type Transition,
	updateStats,
} from "./actions.ts"
import { effectiveAnnoyance, reminderMinutes } from "./annoyance.ts"
import { taskActionRow, tokenButton } from "./buttons.ts"
import {
	addDays,
	formatMinute,
	type LocalDate,
	type LocalMoment,
	minutesUntilMidnight,
} from "./calendar.ts"
import type { Participant, ParticipantId, State, Task, Token } from "./model.ts"
import { type Outgoing, send } from "./outbox.ts"
import { participantName, projectAll, responsibleOn } from "./schedule.ts"
import { bold, overdueSuffix, reminderHeadline, taskLabel } from "./texts.ts"

interface Step {
	readonly state: State
	readonly outbox: ReadonlyArray<Outgoing>
}

const jointSuffix = (task: Task): string => (task.kind === "joint" ? " (gemeinsam)" : "")

const taskLine = (task: Task): string =>
	`• ${taskLabel(task)}${jointSuffix(task)}${overdueSuffix(task.current.misses)}`

// ---------------------------------------------------------------------------
// Midnight rollover
// ---------------------------------------------------------------------------

const punishRotatingMiss = (
	state: State,
	task: Task,
	culprit: ParticipantId,
	day: LocalDate,
): Step => {
	const rivals = state.participants.filter((p) => p.id !== culprit)
	let next = state
	const tokens: Array<Token> = []
	for (const rival of rivals) {
		tokens.push({
			id: `j${next.nextId}`,
			taskId: task.id,
			holder: rival.id,
			debtor: culprit,
			earnedOn: addDays(day, -1),
		})
		next = { ...next, nextId: next.nextId + 1 }
	}
	next = updateStats({ ...next, tokens: [...next.tokens, ...tokens] }, culprit, (s) => ({
		...s,
		missed: s.missed + 1,
	}))
	const culpritName = bold(participantName(state, culprit))
	const culpritChat = state.participants.find((p) => p.id === culprit)?.chatId
	const rivalNames = rivals.map((r) => bold(r.name)).join(" und ") || "niemand"
	const gets = rivals.length > 1 ? "bekommen jeweils" : "bekommt"
	const outbox: Array<Outgoing> = []
	if (culpritChat !== undefined) {
		outbox.push(
			send(
				culpritChat,
				`Mitternacht ist vorbei, ${taskLabel(task)} ist es nicht.\n\nDie Aufgabe ist heute wieder fällig, die Nervigkeit steigt, und ${rivalNames} ${gets} ein Token gegen dich.`,
			),
		)
	}
	for (const rival of rivals) {
		outbox.push(
			send(
				rival.chatId,
				`${culpritName} hat ${taskLabel(task)} nicht erledigt. Du bekommst dafür ein Token.\nWenn du das nächste Mal dran bist, kannst du es einlösen (/token). Dann ist ${culpritName} dran.`,
			),
		)
	}
	return { state: next, outbox }
}

const punishJointMiss = (state: State, task: Task): Step => {
	let next = state
	for (const p of state.participants) {
		next = updateStats(next, p.id, (s) => ({ ...s, missed: s.missed + 1 }))
	}
	return {
		state: next,
		outbox: state.participants.map((p) =>
			send(
				p.chatId,
				`${taskLabel(task)} ist liegen geblieben. Von allen. Heute ist die nächste Gelegenheit.`,
			),
		),
	}
}

/** Processes the transition into `day`: punishes misses from yesterday and postpones blocked tasks. */
export const rolloverDay = (state: State, day: LocalDate): Step => {
	let next = state
	const outbox: Array<Outgoing> = []
	for (const original of state.tasks) {
		let task = next.tasks.find((t) => t.id === original.id) ?? original
		if (task.current.dueDate < day) {
			const missedOn = task.current.dueDate
			const responsible = responsibleOn(next, task, missedOn)
			const culprit = responsible[0]
			if (task.kind === "rotating" && culprit !== undefined) {
				const step = punishRotatingMiss(next, task, culprit, day)
				next = step.state
				outbox.push(...step.outbox)
				task = {
					...task,
					current: { ...task.current, assignee: culprit, misses: task.current.misses + 1 },
				}
			} else if (task.kind === "joint" && responsible.length > 0) {
				const step = punishJointMiss(next, task)
				next = step.state
				outbox.push(...step.outbox)
				task = { ...task, current: { ...task.current, misses: task.current.misses + 1 } }
			}
			task = { ...task, current: { ...task.current, dueDate: day, lastReminder: null } }
		}
		if (
			task.current.dueDate === day &&
			next.participants.length > 0 &&
			responsibleOn(next, task, day).length === 0
		) {
			// Nobody can do it today (vacation) – quietly try again tomorrow.
			task = { ...task, current: { ...task.current, dueDate: addDays(day, 1), lastReminder: null } }
		}
		next = replaceTask(next, task)
	}
	const tasks = next.tasks
	next = {
		...next,
		vacations: next.vacations.filter((v) => v.to >= day),
		// Requests for past dates or for occurrences that are done by now are moot.
		reschedules: next.reschedules.filter(
			(r) => r.to >= day && tasks.some((t) => t.id === r.taskId && t.current.index === r.index),
		),
		lastRollover: day,
	}
	return { state: next, outbox }
}

const rollover = (state: State, today: LocalDate): Step => {
	if (state.lastRollover === null) {
		return { state: { ...state, lastRollover: today }, outbox: [] }
	}
	let step: Step = { state, outbox: [] }
	for (let day = addDays(state.lastRollover, 1); day <= today; day = addDays(day, 1)) {
		const result = rolloverDay(step.state, day)
		step = { state: result.state, outbox: [...step.outbox, ...result.outbox] }
	}
	return step
}

// ---------------------------------------------------------------------------
// Morning digest
// ---------------------------------------------------------------------------

export const dueTodayFor = (
	state: State,
	participant: ParticipantId,
	today: LocalDate,
): ReadonlyArray<Task> =>
	state.tasks.filter(
		(t) => t.current.dueDate === today && responsibleOn(state, t, today).includes(participant),
	)

const digestFor = (
	state: State,
	participant: Participant,
	now: LocalMoment,
): Outgoing | undefined => {
	const today = now.date
	const tomorrow = addDays(today, 1)
	const dueToday = dueTodayFor(state, participant.id, today)
	const dueTomorrow = projectAll(state, tomorrow, tomorrow).filter(
		(o) => o.date === tomorrow && o.responsible.includes(participant.id),
	)
	if (dueToday.length === 0 && dueTomorrow.length === 0) {
		return undefined
	}

	const lines: Array<string> = [`Guten Morgen, ${bold(participant.name)}.`]
	if (dueToday.length > 0) {
		lines.push("", "<b>Heute fällig:</b>", ...dueToday.map(taskLine))
		lines.push(
			"",
			`Ab ${formatMinute(settings.eveningStartMinute)} Uhr erinnere ich in zunehmender Frequenz daran.`,
		)
	} else {
		lines.push("", "Heute ist für dich nichts fällig.")
	}
	if (dueTomorrow.length > 0) {
		lines.push("", "<b>Morgen:</b>", ...dueTomorrow.map((o) => `• ${taskLabel(o.task)}`))
	}

	const tokenTasks = [
		...dueToday,
		...dueTomorrow.filter((o) => o.isCurrent).map((o) => o.task),
	].filter(
		(task) =>
			task.kind === "rotating" &&
			canStillRedeemToken(task.current.dueDate, now) &&
			playableTokens(state, participant.id, task, task.current.dueDate).length > 0,
	)
	if (tokenTasks.length > 0) {
		lines.push(
			"",
			`Du hast ein Token, das sich hier einlösen lässt. Bis ${formatMinute(settings.tokenCutoffMinute)} Uhr am Fälligkeitstag.`,
		)
	}
	return send(participant.chatId, lines.join("\n"), [
		...dueToday.map(taskActionRow),
		...tokenTasks.map((t) => [tokenButton(t)]),
	])
}

const digest = (state: State, now: LocalMoment): Step => {
	if (now.minute < settings.morningDigestMinute || state.lastDigest === now.date) {
		return { state, outbox: [] }
	}
	return {
		state: { ...state, lastDigest: now.date },
		outbox: state.participants.flatMap((p) => digestFor(state, p, now) ?? []),
	}
}

// ---------------------------------------------------------------------------
// Evening escalation
// ---------------------------------------------------------------------------

/** Whether one of the occurrence's reminder slots elapsed since the last reminder that was sent. */
export const reminderDue = (task: Task, now: LocalMoment): boolean => {
	const level = effectiveAnnoyance(task.annoyance, task.current.misses)
	const last = task.current.lastReminder
	const lastMinute = last?.date === now.date ? last.minute : -1
	return reminderMinutes(level).some((m) => m > lastMinute && m <= now.minute)
}

const reminders = (state: State, now: LocalMoment): Step => {
	if (now.minute < settings.eveningStartMinute) {
		return { state, outbox: [] }
	}
	const triggered = state.tasks.filter(
		(t) =>
			t.current.dueDate === now.date &&
			responsibleOn(state, t, now.date).length > 0 &&
			reminderDue(t, now),
	)
	if (triggered.length === 0) {
		return { state, outbox: [] }
	}
	let next = state
	for (const task of triggered) {
		next = replaceTask(next, {
			...task,
			current: { ...task.current, lastReminder: { date: now.date, minute: now.minute } },
		})
	}
	const minutesLeft = minutesUntilMidnight(now.minute)
	const outbox = state.participants.flatMap((p) => {
		const mine = triggered.filter((t) => responsibleOn(state, t, now.date).includes(p.id))
		if (mine.length === 0) {
			return []
		}
		const headline = reminderHeadline(minutesLeft, now.minute + p.id)
		return [
			send(p.chatId, `${headline}\n\n${mine.map(taskLine).join("\n")}`, mine.map(taskActionRow)),
		]
	})
	return { state: next, outbox }
}

/**
 * Runs once per minute. Order matters: the rollover may move overdue tasks to today before the
 * digest and the reminders look at what is due.
 */
export const tick = (state: State, now: LocalMoment): Effect.Effect<Transition> =>
	Effect.sync(() => {
		const rolled = rollover(state, now.date)
		const digested = digest(rolled.state, now)
		const reminded = reminders(digested.state, now)
		return {
			state: reminded.state,
			outbox: [...rolled.outbox, ...digested.outbox, ...reminded.outbox],
		}
	})
