import { settings } from "../settings.ts"
import {
	canReschedule,
	canStillRedeemToken,
	effectiveDueDate,
	isMine,
	nextAfterCompletion,
	playableTokens,
	rescheduleOptions,
	taskButtons,
	vacationRange,
} from "./actions.ts"
import { formatPreview, MAX_ANNOYANCE } from "./annoyance.ts"
import { taskActionRow, tokenButton } from "./buttons.ts"
import { formatCadence } from "./cadence.ts"
import {
	addDays,
	formatDate,
	formatMinute,
	formatRelativeDate,
	formatWhen,
	type LocalDate,
	type LocalMoment,
} from "./calendar.ts"
import { encodeCallback } from "./callbacks.ts"
import type { ParticipantId, State, Task } from "./model.ts"
import { column, type Keyboard } from "./outbox.ts"
import { participantName, projectAll, responsibleOn } from "./schedule.ts"
import {
	bold,
	escapeHtml,
	overdueSuffix,
	taskButtonLabel,
	taskLabel,
	taskSummary,
} from "./texts.ts"

export interface View {
	readonly text: string
	readonly keyboard: Keyboard
}

const view = (text: string, keyboard: Keyboard = []): View => ({ text, keyboard })

const names = (state: State, ids: ReadonlyArray<ParticipantId>): string =>
	ids.length === 0
		? "niemand (verschoben)"
		: ids.map((id) => escapeHtml(participantName(state, id))).join(" & ")

const whoDoesIt = (state: State, task: Task, ids: ReadonlyArray<ParticipantId>): string =>
	task.kind === "joint" && ids.length > 0 ? "alle" : names(state, ids)

export const todayView = (state: State, actor: ParticipantId, today: LocalDate): View => {
	const due = state.tasks.filter((t) => effectiveDueDate(state, t) <= today)
	if (due.length === 0) {
		return view("Heute ist nichts fällig. Ungewohnt, aber schön.")
	}
	const lines = due.map((t) => {
		const who = whoDoesIt(state, t, responsibleOn(state, t, today))
		return `• ${taskLabel(t)} – ${who}${overdueSuffix(t.current.misses)}`
	})
	const mine = due.filter((t) => responsibleOn(state, t, today).includes(actor))
	return view(`<b>Heute</b>\n\n${lines.join("\n")}`, mine.map(taskActionRow))
}

export const planView = (state: State, today: LocalDate): View => {
	const until = addDays(today, settings.planHorizonDays - 1)
	const planned = projectAll(state, today, until)
	if (planned.length === 0) {
		return view("In den nächsten zwei Wochen ist nichts geplant. Verdächtig ruhig.")
	}
	const lines: Array<string> = [`<b>Plan bis ${formatDate(until, today)}</b>`]
	let lastDate: string | undefined
	for (const o of planned) {
		const date = o.date < today ? today : o.date
		if (date !== lastDate) {
			lines.push("", `<b>${formatDate(date, today)}</b> (${formatRelativeDate(date, today)})`)
			lastDate = date
		}
		lines.push(
			`• ${taskLabel(o.task)} – ${whoDoesIt(state, o.task, o.responsible)}${overdueSuffix(o.misses)}`,
		)
	}
	const later = state.tasks
		.filter((t) => effectiveDueDate(state, t) > until)
		.map((t) => `• ${taskLabel(t)} – ${formatDate(effectiveDueDate(state, t), today)}`)
	if (later.length > 0) {
		lines.push("", "<b>Später</b>", ...later)
	}
	return view(lines.join("\n"))
}

export const tasksView = (state: State, today: LocalDate): View => {
	if (state.tasks.length === 0) {
		return view("Noch keine Aufgaben. Anlegen mit /neu.")
	}
	const lines = state.tasks.map((t, i) => {
		const due = effectiveDueDate(state, t)
		const who = whoDoesIt(state, t, responsibleOn(state, t, due))
		return `<b>${i + 1}.</b> ${taskSummary(t)}\n     nächstes Mal: ${formatDate(due, today)}, ${who}`
	})
	return view(
		`<b>Aufgaben</b>\n\n${lines.join("\n")}\n\nÄndern mit /rhythmus, /termin, /nervig oder /loeschen.`,
	)
}

export const statsView = (state: State): View => {
	if (state.participants.length === 0) {
		return view("Noch niemand dabei.")
	}
	const lines = state.participants
		.toSorted((a, b) => b.stats.done - a.stats.done)
		.map((p) => {
			const tokens = state.tokens.filter((j) => j.holder === p.id).length
			const s = p.stats
			return `${bold(p.name)}\n   ${s.done} erledigt, ${s.missed} verpasst, ${s.takeovers} übernommen, ${s.tokensPlayed} Tokens eingelöst, ${tokens} übrig`
		})
	return view(`<b>Statistik</b>\n\n${lines.join("\n\n")}`)
}

const withinPicker = (state: State, task: Task, today: LocalDate): boolean =>
	effectiveDueDate(state, task) <= addDays(today, settings.pickerHorizonDays)

const pickerLabel = (state: State, task: Task, today: LocalDate): string =>
	`${taskButtonLabel(task)} (${formatRelativeDate(effectiveDueDate(state, task), today)})`

/** Due today (or overdue) and mine: one tap is enough. Everything else gets a confirmation. */
const doneButtonFor = (state: State, task: Task, actor: ParticipantId, today: LocalDate) => {
	const onSchedule = effectiveDueDate(state, task) <= today && isMine(state, task, actor)
	const ref = { taskId: task.id, index: task.current.index }
	return {
		text: pickerLabel(state, task, today),
		data: encodeCallback(onSchedule ? { _tag: "Done", ...ref } : { _tag: "DoneAsk", ...ref }),
	}
}

const myUpcoming = (state: State, actor: ParticipantId, today: LocalDate): ReadonlyArray<Task> =>
	state.tasks.filter((t) => withinPicker(state, t, today) && isMine(state, t, actor))

const otherThanMine = {
	text: "Etwas anderes erledigt",
	data: encodeCallback({ _tag: "DoneOther" }),
}

export const donePicker = (state: State, actor: ParticipantId, today: LocalDate): View => {
	const mine = myUpcoming(state, actor, today)
	const more = state.tasks.length > mine.length ? [[otherThanMine]] : []
	if (mine.length === 0) {
		return view(
			"In den nächsten Tagen steht für dich nichts an. Außer der Reihe geht natürlich trotzdem.",
			more,
		)
	}
	return view("Was ist erledigt?", [
		...column(mine.map((t) => doneButtonFor(state, t, actor, today))),
		...more,
	])
}

/** Every other task, whoever's turn and whenever it is due. */
export const doneOtherPicker = (state: State, actor: ParticipantId, today: LocalDate): View => {
	const mine = new Set(myUpcoming(state, actor, today).map((t) => t.id))
	const rest = state.tasks.filter((t) => !mine.has(t.id))
	if (rest.length === 0) {
		return view("Da ist nichts weiter. Alles andere steht schon in der Liste davor.")
	}
	return view(
		"Was wurde außer der Reihe erledigt?",
		column(
			rest.map((t) => {
				const due = effectiveDueDate(state, t)
				const who = whoDoesIt(state, t, responsibleOn(state, t, due))
				return {
					text: `${taskButtonLabel(t)} (${formatRelativeDate(due, today)}, ${who})`,
					data: encodeCallback({ _tag: "DoneAsk", taskId: t.id, index: t.current.index }),
				}
			}),
		),
	)
}

/** Explains what an off-schedule check-off will do before it happens. */
export const doneConfirm = (
	state: State,
	task: Task,
	actor: ParticipantId,
	today: LocalDate,
): View => {
	const due = effectiveDueDate(state, task)
	const responsible = responsibleOn(state, task, due)
	const lines: Array<string> = []
	if (task.kind === "rotating" && responsible.length > 0 && !responsible.includes(actor)) {
		lines.push(
			`Eigentlich ist ${names(state, responsible)} bei ${taskLabel(task)} dran. Wenn du es abhakst, ist ${names(state, responsible)} diesmal raus.`,
		)
	} else {
		lines.push(`${taskLabel(task)} ist ${formatRelativeDate(due, today)} fällig.`)
	}
	const { occurrence, offSchedule } = nextAfterCompletion(state, task, today)
	lines.push(
		offSchedule
			? `Da es früher erledigt ist, zählt der Rhythmus ab heute. Nächstes Mal wäre dann ${formatWhen(occurrence.dueDate, today)}.`
			: `Nächstes Mal wäre dann ${formatWhen(occurrence.dueDate, today)}.`,
	)
	return view(`${lines.join("\n\n")}\n\nAbhaken?`, [
		[
			{
				text: "Ja, erledigt",
				data: encodeCallback({ _tag: "DoneConfirm", taskId: task.id, index: task.current.index }),
			},
			{ text: "Abbrechen", data: encodeCallback({ _tag: "Dismiss" }) },
		],
	])
}

export const reschedulePicker = (state: State, actor: ParticipantId, today: LocalDate): View => {
	const movable = state.tasks.filter(
		(t) => withinPicker(state, t, today) && canReschedule(state, t, actor),
	)
	if (movable.length === 0) {
		return view("Du hast in den nächsten Tagen nichts, was sich verschieben ließe.")
	}
	return view(
		"Welcher Termin soll verschoben werden? Einmalig, der Rhythmus bleibt.",
		column(
			movable.map((t) => ({
				text: pickerLabel(state, t, today),
				data: encodeCallback({ _tag: "RescheduleStart", taskId: t.id, index: t.current.index }),
			})),
		),
	)
}

export const rescheduleDatePicker = (state: State, task: Task, today: LocalDate): View => {
	const due = effectiveDueDate(state, task)
	const options = rescheduleOptions(state, task, today).map((date) => ({
		text: date <= addDays(today, 2) ? formatRelativeDate(date, today) : formatDate(date, today),
		data: encodeCallback({
			_tag: "ReschedulePick",
			taskId: task.id,
			index: task.current.index,
			date,
		}),
	}))
	const rows: Array<typeof options> = []
	for (let i = 0; i < options.length; i += 3) {
		rows.push(options.slice(i, i + 3))
	}
	return view(
		`${taskLabel(task)} ist ${formatRelativeDate(due, today)} fällig. Auf wann soll es verschoben werden?\nDas muss noch jemand genehmigen. Andere Daten gehen per <code>/verschieben Nr | Datum</code>.`,
		[...rows, [{ text: "Abbrechen", data: encodeCallback({ _tag: "Dismiss" }) }]],
	)
}

export const takeOverPicker = (state: State, actor: ParticipantId, today: LocalDate): View => {
	const theirs = state.tasks.filter((t) => {
		const responsible = responsibleOn(state, t, effectiveDueDate(state, t))
		return (
			t.kind === "rotating" &&
			withinPicker(state, t, today) &&
			responsible.length > 0 &&
			!responsible.includes(actor)
		)
	})
	if (theirs.length === 0) {
		return view("Gerade gibt es nichts zu übernehmen.")
	}
	return view(
		"Welche Aufgabe willst du übernehmen? Dafür gibt es nichts, außer vielleicht Dankbarkeit.",
		column(
			theirs.map((t) => ({
				text: `${pickerLabel(state, t, today)} von ${participantName(state, responsibleOn(state, t, effectiveDueDate(state, t))[0] ?? actor)}`,
				data: encodeCallback({ _tag: "TakeOver", taskId: t.id, index: t.current.index }),
			})),
		),
	)
}

export const tokenView = (state: State, actor: ParticipantId, now: LocalMoment): View => {
	const mine = state.tokens.filter((j) => j.holder === actor)
	if (mine.length === 0) {
		return view("Du hast keine Tokens. Die gibt es, wenn jemand anderes etwas verpasst.")
	}
	const lines = mine.map((j) => {
		const task = state.tasks.find((t) => t.id === j.taskId)
		const label = task ? taskLabel(task) : "?"
		return `• ${label} gegen ${bold(participantName(state, j.debtor))} (seit ${formatDate(j.earnedOn, now.date)})`
	})
	const playable = state.tasks.filter((t) => {
		const due = effectiveDueDate(state, t)
		return (
			t.kind === "rotating" &&
			responsibleOn(state, t, due).includes(actor) &&
			canStillRedeemToken(due, now) &&
			playableTokens(state, actor, t, due).length > 0
		)
	})
	const hint =
		playable.length > 0
			? "\n\nEinlösbar:"
			: `\n\nGerade nicht einlösbar. Das geht nur für deinen nächsten Termin der Aufgabe, bis ${formatMinute(settings.tokenCutoffMinute)} Uhr am Fälligkeitstag.`
	return view(
		`<b>Deine Tokens</b>\n\n${lines.join("\n")}${hint}`,
		playable.map((t) => [tokenButton(t)]),
	)
}

export const vacationsView = (state: State, actor: ParticipantId, today: LocalDate): View => {
	const usage = "Beantragen mit <code>/urlaub 20.12. 03.01.</code>"
	if (state.vacations.length === 0) {
		return view(`Keine Urlaube geplant.\n\n${usage}`)
	}
	const lines = state.vacations.map(
		(v) =>
			`• ${bold(participantName(state, v.participant))}: ${vacationRange(v, today)}${v.status === "pending" ? " (wartet auf Genehmigung)" : " (genehmigt)"}`,
	)
	const keyboard: Keyboard = state.vacations.flatMap((v) => {
		if (v.participant === actor) {
			return [
				[
					{
						text: `Absagen: ${vacationRange(v, today)}`,
						data: encodeCallback({ _tag: "VacationCancel", vacationId: v.id }),
					},
				],
			]
		}
		if (v.status === "pending") {
			return [
				[
					{
						text: `Genehmigen: ${participantName(state, v.participant)}`,
						data: encodeCallback({ _tag: "VacationApprove", vacationId: v.id }),
					},
					{
						text: "Ablehnen",
						data: encodeCallback({ _tag: "VacationReject", vacationId: v.id }),
					},
				],
			]
		}
		return []
	})
	return view(`<b>Urlaube</b>\n\n${lines.join("\n")}\n\n${usage}`, keyboard)
}

export const annoyanceTaskPicker = (state: State): View =>
	view(
		"Für welche Aufgabe soll die Nervigkeit eingestellt werden?",
		taskButtons(state.tasks, (t) => encodeCallback({ _tag: "AnnoyancePick", taskId: t.id })),
	)

export const annoyanceLevelPicker = (task: Task): View => {
	const levels = Array.from({ length: MAX_ANNOYANCE + 1 }, (_, level) => ({
		text: level === task.annoyance ? `[${level}]` : String(level),
		data: encodeCallback({ _tag: "AnnoyancePreview", taskId: task.id, level }),
	}))
	return view(
		`${taskLabel(task)}, aktuell Stufe ${task.annoyance}.\nWähle eine Stufe für die Vorschau:`,
		[levels.slice(0, 6), levels.slice(6)],
	)
}

export const annoyancePreviewView =
	(task: Task): ((level: number) => View) =>
	(level) =>
		view(
			`${taskLabel(task)}\n\n${formatPreview(level)}\n\n<i>Jeder verpasste Tag erhöht die Stufe um ${settings.annoyanceBoostPerMiss}.</i>`,
			[
				[
					{
						text: `Stufe ${level} speichern`,
						data: encodeCallback({ _tag: "AnnoyanceSave", taskId: task.id, level }),
					},
				],
				[
					{
						text: "Andere Stufe",
						data: encodeCallback({ _tag: "AnnoyancePick", taskId: task.id }),
					},
				],
			],
		)

export const deletePicker = (state: State): View =>
	state.tasks.length === 0
		? view("Es gibt keine Aufgaben zum Löschen.")
		: view(
				"Welche Aufgabe soll weg?",
				taskButtons(state.tasks, (t) => encodeCallback({ _tag: "DeleteAsk", taskId: t.id })),
			)

export const deleteConfirm = (task: Task): View =>
	view(
		`${taskLabel(task)} (${formatCadence(task.cadence)}) wirklich löschen? Zugehörige Tokens verfallen.`,
		[
			[
				{ text: "Löschen", data: encodeCallback({ _tag: "DeleteConfirm", taskId: task.id }) },
				{ text: "Abbrechen", data: encodeCallback({ _tag: "Dismiss" }) },
			],
		],
	)
