import { settings } from "../settings.ts"
import { formatCadence } from "./cadence.ts"
import { formatMinute } from "./calendar.ts"
import type { Task } from "./model.ts"

export const escapeHtml = (text: string): string =>
	text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")

export const bold = (text: string): string => `<b>${escapeHtml(text)}</b>`

export const taskLabel = (task: Pick<Task, "name">): string => bold(task.name)

export const taskButtonLabel = (task: Pick<Task, "name">): string => task.name

export const taskSummary = (task: Task): string =>
	`${taskLabel(task)}, ${formatCadence(task.cadence)}${task.kind === "joint" ? ", gemeinsam" : ""}, Nervigkeit ${task.annoyance}/10`

export const overdueSuffix = (misses: number): string => {
	if (misses === 0) {
		return ""
	}
	return misses === 1 ? " (seit gestern überfällig)" : ` (seit ${misses} Tagen überfällig)`
}

export const minutes = (count: number): string => (count === 1 ? "1 Minute" : `${count} Minuten`)

export const pick = <A>(options: ReadonlyArray<A>, seed: number): A => {
	const value = options[Math.abs(Math.trunc(seed)) % options.length]
	if (value === undefined) {
		throw new Error("pick() needs at least one option")
	}
	return value
}

/** Evening reminder headlines, keyed by the time left until midnight. Drier the later it gets. */
export const reminderHeadline = (minutesLeft: number, seed: number): string => {
	const hours = Math.floor(minutesLeft / 60)
	if (minutesLeft > 180) {
		return pick(
			[
				"Nur zur Erinnerung, falls es untergegangen ist:",
				"Heute noch fällig. Kein Stress. Noch nicht.",
				"Der Abend ist lang. Das hier ist trotzdem noch offen:",
			],
			seed,
		)
	}
	if (minutesLeft > 60) {
		return pick(
			[
				`Noch ${hours} Stunden bis Mitternacht. Weiterhin offen:`,
				"Ich frage ungern zweimal. Offen ist noch:",
				"Immer noch offen. Überraschend, ich weiß:",
			],
			seed,
		)
	}
	if (minutesLeft > 15) {
		return pick(
			[
				`Noch ${minutes(minutesLeft)}. Offen ist weiterhin:`,
				`${minutes(minutesLeft)} bis Mitternacht. Kann man schaffen. Theoretisch.`,
				"Die Uhr läuft übrigens weiter. Offen:",
			],
			seed,
		)
	}
	return pick(
		[
			`Noch ${minutes(minutesLeft)}.`,
			`${minutes(minutesLeft)}. Ich höre erst auf, wenn es erledigt ist.`,
			`${minutes(minutesLeft)} bis zum Token für die anderen.`,
			"Ich habe Zeit. Du nicht mehr.",
		],
		seed,
	)
}

export const HELP_TEXT = [
	"<b>Befehle</b>",
	"",
	"Die Knöpfe unten decken das Übliche ab. Der Rest:",
	"",
	"/heute – was heute ansteht",
	"/plan – die nächsten zwei Wochen",
	"/erledigt – Aufgabe abhaken, auch außer der Reihe",
	"/verschieben – einen Termin einmalig verschieben (muss genehmigt werden)",
	"/uebernehmen – freiwillig eine Aufgabe übernehmen",
	"/token – Tokens ansehen und einlösen",
	"/urlaub 20.12. 03.01. – Urlaub beantragen (ohne Daten: Übersicht)",
	"/punkte – Statistik",
	"",
	"<b>Aufgaben verwalten</b>",
	"/aufgaben – alle Aufgaben",
	"/neu Name | Rhythmus | gemeinsam | ab Datum – neue Aufgabe",
	"   z. B. <code>/neu Pflanzen gießen | alle 3 Tage</code>",
	"   oder <code>/neu Kühlschrank putzen | monatlich | gemeinsam | ab 01.11.</code>",
	"/rhythmus Nr | Rhythmus – Rhythmus dauerhaft ändern",
	"/termin Nr | Datum – Raster dauerhaft auf ein neues Datum legen",
	"/nervig – Nervigkeit einstellen, mit Vorschau",
	"/vorschau 0–10 – Vorschau einer Nervigkeitsstufe",
	"/loeschen – Aufgabe löschen",
	"",
	"<b>Regeln</b>",
	`• Wer eine Aufgabe bis Mitternacht nicht erledigt, hat sie am nächsten Tag wieder, und alle anderen bekommen ein Token. Ab ${formatMinute(settings.eveningStartMinute)} Uhr wird erinnert, gegen Mitternacht minütlich.`,
	`• Mit einem Token muss der Schuldige einen deiner Termine übernehmen. Einlösbar bis ${formatMinute(settings.tokenCutoffMinute)} Uhr am Fälligkeitstag, gern auch früher.`,
	"• Wer früher erledigt, setzt den Rhythmus neu: das nächste Mal zählt ab dem Tag, an dem es erledigt wurde. Fremde Aufgaben abhaken geht auch, dann ist der andere diesmal raus.",
	"• Verschieben und Urlaub muss jemand anderes genehmigen. Im Urlaub übernehmen die anderen, ohne Tokens.",
].join("\n")
