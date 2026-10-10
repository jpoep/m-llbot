import { settings } from "../settings.ts"
import { formatCadence } from "./cadence.ts"
import { formatMinute } from "./calendar.ts"
import type { Task } from "./model.ts"

export const escapeHtml = (text: string): string =>
	text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")

export const bold = (text: string): string => `<b>${escapeHtml(text)}</b>`

export const taskLabel = (task: Pick<Task, "emoji" | "name">): string =>
	`${task.emoji} ${escapeHtml(task.name)}`

export const taskButtonLabel = (task: Pick<Task, "emoji" | "name">): string =>
	`${task.emoji} ${task.name}`

export const taskSummary = (task: Task): string =>
	`${taskLabel(task)} – ${formatCadence(task.cadence)}${task.kind === "joint" ? ", gemeinsam 👫" : ""}, Nervigkeit ${task.annoyance}/10`

export const overdueSuffix = (misses: number): string => {
	if (misses === 0) {
		return ""
	}
	return misses === 1 ? " 🔥 seit gestern überfällig" : ` 🔥 seit ${misses} Tagen überfällig`
}

export const pick = <A>(options: ReadonlyArray<A>, seed: number): A => {
	const value = options[Math.abs(Math.trunc(seed)) % options.length]
	if (value === undefined) {
		throw new Error("pick() needs at least one option")
	}
	return value
}

/** Escalating evening reminder headlines, keyed by minutes left until midnight. */
export const reminderHeadline = (minutesLeft: number, seed: number): string => {
	const hours = Math.floor(minutesLeft / 60)
	if (minutesLeft > 180) {
		return pick(
			[
				"⏰ Kleine Erinnerung für heute:",
				"⏰ Nur damit's nicht untergeht:",
				"⏰ Der Abend ist jung, die Aufgabe noch offen:",
			],
			seed,
		)
	}
	if (minutesLeft > 60) {
		return pick(
			[
				`😤 Noch ${hours} Stunden bis Mitternacht. Das hier ist immer noch offen:`,
				"😤 Es wird langsam Zeit:",
				"😤 Hallo?? Immer noch offen:",
			],
			seed,
		)
	}
	if (minutesLeft > 15) {
		return pick(
			[
				`🚨 Noch ${minutesLeft} Minuten! Immer noch nicht erledigt:`,
				`🚨 ${minutesLeft} Minuten bis zur Strafe:`,
				"🚨 Die Uhr tickt. Laut. Offen ist noch:",
			],
			seed,
		)
	}
	return pick(
		[
			`💀 ${minutesLeft} MINUTEN.`,
			`💀 NOCH ${minutesLeft} MINUTEN. JETZT.`,
			`💀 ${minutesLeft}… und dein Mitbewohner kriegt einen Joker.`,
			"💀 Ich höre nicht auf. Niemals.",
		],
		seed,
	)
}

export const HELP_TEXT = [
	"🧹 <b>Müllbot – Befehle</b>",
	"",
	"<b>Alltag</b>",
	"/heute – was heute ansteht",
	"/plan – die nächsten zwei Wochen",
	"/erledigt – Aufgabe abhaken",
	"/uebernehmen – freiwillig eine Aufgabe übernehmen",
	"/joker – Joker ansehen und einsetzen",
	"/urlaub 20.12. 03.01. – Urlaub beantragen (ohne Daten: Übersicht)",
	"/punkte – Statistik",
	"",
	"<b>Aufgaben verwalten</b>",
	"/aufgaben – alle Aufgaben",
	"/neu Name | Rhythmus | gemeinsam | ab Datum – neue Aufgabe",
	"   z. B. <code>/neu Pflanzen gießen | alle 3 Tage</code>",
	"   oder <code>/neu Kühlschrank putzen | monatlich | gemeinsam | ab 01.11.</code>",
	"/rhythmus Nr | Rhythmus – Rhythmus ändern",
	"/termin Nr | Datum – nächsten Termin verschieben",
	"/nervig – Nervigkeit einstellen (mit Vorschau)",
	"/vorschau 0–10 – Vorschau einer Nervigkeitsstufe",
	"/loeschen – Aufgabe löschen",
	"",
	"<b>Regeln</b>",
	`• Wer eine Aufgabe bis Mitternacht nicht erledigt, hat sie am nächsten Tag wieder – und alle anderen bekommen einen 🃏 Joker. Ab ${formatMinute(settings.eveningStartMinute)} Uhr wird es laut.`,
	`• Mit einem Joker muss der Schuldige einen deiner Termine übernehmen. Einsetzbar bis ${formatMinute(settings.jokerCutoffMinute)} Uhr am Fälligkeitstag – auch schon Tage vorher.`,
	"• Urlaub muss von jemand anderem genehmigt werden. Deine Aufgaben übernehmen dann die anderen – ohne Joker.",
].join("\n")
