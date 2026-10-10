import { settings } from "../settings.ts"
import {
	canStillPlayJoker,
	effectiveDueDate,
	playableJokers,
	taskButtons,
	vacationRange,
} from "./actions.ts"
import { formatPreview, MAX_ANNOYANCE } from "./annoyance.ts"
import { formatCadence } from "./cadence.ts"
import {
	addDays,
	formatDate,
	formatMinute,
	formatRelativeDate,
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
	task.kind === "joint" && ids.length > 0 ? "alle 👫" : names(state, ids)

export const todayView = (state: State, actor: ParticipantId, today: LocalDate): View => {
	const due = state.tasks.filter((t) => effectiveDueDate(state, t) <= today)
	if (due.length === 0) {
		return view("🎉 Heute steht nichts an. Genießt es!")
	}
	const lines = due.map((t) => {
		const who = whoDoesIt(state, t, responsibleOn(state, t, today))
		return `• ${taskLabel(t)} → ${who}${overdueSuffix(t.current.misses)}`
	})
	const mine = due.filter((t) => responsibleOn(state, t, today).includes(actor))
	return view(
		`📋 <b>Heute</b>\n\n${lines.join("\n")}`,
		column(
			mine.map((t) => ({
				text: `✅ ${taskButtonLabel(t)}`,
				data: encodeCallback({ _tag: "Done", taskId: t.id, index: t.current.index }),
			})),
		),
	)
}

export const planView = (state: State, today: LocalDate): View => {
	const until = addDays(today, settings.planHorizonDays - 1)
	const planned = projectAll(state, today, until)
	if (planned.length === 0) {
		return view("📅 Die nächsten zwei Wochen ist nichts geplant.")
	}
	const lines: Array<string> = [`📅 <b>Plan bis ${formatDate(until, today)}</b>`]
	let lastDate: string | undefined
	for (const o of planned) {
		const date = o.date < today ? today : o.date
		if (date !== lastDate) {
			lines.push("", `<b>${formatDate(date, today)}</b> (${formatRelativeDate(date, today)})`)
			lastDate = date
		}
		lines.push(
			`• ${taskLabel(o.task)} → ${whoDoesIt(state, o.task, o.responsible)}${overdueSuffix(o.misses)}`,
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
		return view("Noch keine Aufgaben. Leg eine an mit /neu.")
	}
	const lines = state.tasks.map((t, i) => {
		const due = effectiveDueDate(state, t)
		const who = whoDoesIt(state, t, responsibleOn(state, t, due))
		return `<b>${i + 1}.</b> ${taskSummary(t)}\n     nächstes Mal: ${formatDate(due, today)} → ${who}`
	})
	return view(
		`📝 <b>Aufgaben</b>\n\n${lines.join("\n")}\n\nÄndern: /rhythmus, /termin, /nervig, /loeschen`,
	)
}

export const statsView = (state: State): View => {
	if (state.participants.length === 0) {
		return view("Noch niemand dabei.")
	}
	const lines = state.participants
		.toSorted((a, b) => b.stats.done - a.stats.done)
		.map((p) => {
			const jokers = state.jokers.filter((j) => j.holder === p.id).length
			const s = p.stats
			return `${bold(p.name)}\n   ✅ ${s.done} erledigt · 💀 ${s.missed} verpennt · 🦸 ${s.takeovers} übernommen · 🃏 ${s.jokersPlayed} gespielt, ${jokers} auf der Hand`
		})
	return view(`🏆 <b>Punkte</b>\n\n${lines.join("\n\n")}`)
}

const withinPicker = (state: State, task: Task, today: LocalDate): boolean =>
	effectiveDueDate(state, task) <= addDays(today, settings.pickerHorizonDays)

const pickerLabel = (state: State, task: Task, today: LocalDate): string =>
	`${taskButtonLabel(task)} (${formatRelativeDate(effectiveDueDate(state, task), today)})`

export const donePicker = (state: State, actor: ParticipantId, today: LocalDate): View => {
	const mine = state.tasks.filter(
		(t) =>
			withinPicker(state, t, today) &&
			responsibleOn(state, t, effectiveDueDate(state, t)).includes(actor),
	)
	if (mine.length === 0) {
		return view("Für dich steht in den nächsten Tagen nichts an. 😌")
	}
	return view(
		"Was hast du erledigt?",
		column(
			mine.map((t) => ({
				text: `✅ ${pickerLabel(state, t, today)}`,
				data: encodeCallback({ _tag: "Done", taskId: t.id, index: t.current.index }),
			})),
		),
	)
}

export const takeOverPicker = (state: State, actor: ParticipantId, today: LocalDate): View => {
	const theirs = state.tasks.filter((t) => {
		const due = effectiveDueDate(state, t)
		const responsible = responsibleOn(state, t, due)
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
		"🦸 Welche Aufgabe willst du übernehmen? (Gibt keinen Joker – nur Karma.)",
		column(
			theirs.map((t) => ({
				text: `🦸 ${pickerLabel(state, t, today)} – ${participantName(state, responsibleOn(state, t, effectiveDueDate(state, t))[0] ?? actor)}`,
				data: encodeCallback({ _tag: "TakeOver", taskId: t.id, index: t.current.index }),
			})),
		),
	)
}

export const jokerView = (state: State, actor: ParticipantId, now: LocalMoment): View => {
	const mine = state.jokers.filter((j) => j.holder === actor)
	if (mine.length === 0) {
		return view("🃏 Du hast keine Joker. Warte, bis jemand was verpennt. 😈")
	}
	const lines = mine.map((j) => {
		const task = state.tasks.find((t) => t.id === j.taskId)
		const label = task ? taskLabel(task) : "?"
		return `• ${label} – gegen ${bold(participantName(state, j.debtor))} (seit ${formatDate(j.earnedOn, now.date)})`
	})
	const playable = state.tasks.filter((t) => {
		const due = effectiveDueDate(state, t)
		return (
			t.kind === "rotating" &&
			responsibleOn(state, t, due).includes(actor) &&
			canStillPlayJoker(due, now) &&
			playableJokers(state, actor, t, due).length > 0
		)
	})
	const hint =
		playable.length > 0
			? "\n\nJetzt einsetzbar:"
			: `\n\nGerade nicht einsetzbar – das geht nur für deinen nächsten Termin der Aufgabe, bis ${formatMinute(settings.jokerCutoffMinute)} Uhr am Fälligkeitstag.`
	return view(
		`🃏 <b>Deine Joker</b>\n\n${lines.join("\n")}${hint}`,
		column(
			playable.map((t) => ({
				text: `🃏 ${pickerLabel(state, t, now.date)}`,
				data: encodeCallback({ _tag: "Joker", taskId: t.id, index: t.current.index }),
			})),
		),
	)
}

export const vacationsView = (state: State, actor: ParticipantId, today: LocalDate): View => {
	const usage = "Beantragen: <code>/urlaub 20.12. 03.01.</code>"
	if (state.vacations.length === 0) {
		return view(`🏖️ Keine Urlaube geplant.\n\n${usage}`)
	}
	const lines = state.vacations.map(
		(v) =>
			`• ${bold(participantName(state, v.participant))}: ${vacationRange(v, today)}${v.status === "pending" ? " ⏳ wartet auf Genehmigung" : " ✅"}`,
	)
	const keyboard: Keyboard = state.vacations.flatMap((v) => {
		if (v.participant === actor) {
			return [
				[
					{
						text: `❌ Absagen: ${vacationRange(v, today)}`,
						data: encodeCallback({ _tag: "VacationCancel", vacationId: v.id }),
					},
				],
			]
		}
		if (v.status === "pending") {
			return [
				[
					{
						text: `✅ ${participantName(state, v.participant)} genehmigen`,
						data: encodeCallback({ _tag: "VacationApprove", vacationId: v.id }),
					},
					{
						text: "❌ Ablehnen",
						data: encodeCallback({ _tag: "VacationReject", vacationId: v.id }),
					},
				],
			]
		}
		return []
	})
	return view(`🏖️ <b>Urlaube</b>\n\n${lines.join("\n")}\n\n${usage}`, keyboard)
}

export const annoyanceTaskPicker = (state: State): View =>
	view(
		"🔔 Für welche Aufgabe willst du die Nervigkeit einstellen?",
		taskButtons(state.tasks, (t) => encodeCallback({ _tag: "AnnoyancePick", taskId: t.id })),
	)

export const annoyanceLevelPicker = (task: Task): View => {
	const levels = Array.from({ length: MAX_ANNOYANCE + 1 }, (_, level) => ({
		text: level === task.annoyance ? `• ${level} •` : String(level),
		data: encodeCallback({ _tag: "AnnoyancePreview", taskId: task.id, level }),
	}))
	return view(
		`🔔 ${taskLabel(task)} – aktuell ${task.annoyance}/10.\nWähle eine Stufe, um die Vorschau zu sehen:`,
		[levels.slice(0, 6), levels.slice(6)],
	)
}

export const annoyancePreviewView =
	(task: Task): ((level: number) => View) =>
	(level) =>
		view(
			`${taskLabel(task)}\n\n${formatPreview(level)}\n\n<i>Jeder verpennte Tag erhöht die Stufe um ${settings.annoyanceBoostPerMiss}.</i>`,
			[
				[
					{
						text: `💾 Stufe ${level} speichern`,
						data: encodeCallback({ _tag: "AnnoyanceSave", taskId: task.id, level }),
					},
				],
				[
					{
						text: "↩️ Andere Stufe",
						data: encodeCallback({ _tag: "AnnoyancePick", taskId: task.id }),
					},
				],
			],
		)

export const deletePicker = (state: State): View =>
	state.tasks.length === 0
		? view("Es gibt keine Aufgaben zum Löschen.")
		: view(
				"🗑️ Welche Aufgabe soll weg?",
				taskButtons(state.tasks, (t) => encodeCallback({ _tag: "DeleteAsk", taskId: t.id })),
			)

export const deleteConfirm = (task: Task): View =>
	view(
		`🗑️ ${taskLabel(task)} (${formatCadence(task.cadence)}) wirklich löschen? Zugehörige Joker verfallen.`,
		[
			[
				{ text: "🗑️ Ja, löschen", data: encodeCallback({ _tag: "DeleteConfirm", taskId: task.id }) },
				{ text: "Abbrechen", data: encodeCallback({ _tag: "Dismiss" }) },
			],
		],
	)
