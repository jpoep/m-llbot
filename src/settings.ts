/**
 * Household-wide knobs that are intentionally configured in code rather than via the bot.
 * All clock times are local times in {@link settings.timeZone}, expressed as minutes after midnight.
 */
export const settings = {
	timeZone: "Europe/Berlin",
	/** When everyone gets their "this is due today" digest. */
	morningDigestMinute: 8 * 60,
	/** When the escalating evening reminders start. */
	eveningStartMinute: 18 * 60,
	/** Jokers for a day's task can only be played before this time on that day. */
	jokerCutoffMinute: 12 * 60,
	/** Every missed day raises the annoyance level of that occurrence by this much (capped at 10). */
	annoyanceBoostPerMiss: 2,
	/** Default annoyance for tasks created via the bot. */
	defaultAnnoyance: 3,
	/** How many days `/plan` looks ahead. */
	planHorizonDays: 14,
	/** How many days ahead tasks are offered in the "done" / "take over" pickers. */
	pickerHorizonDays: 7,
	/** How far ahead a one-off reschedule may move a task. */
	maxRescheduleDays: 14,
	/** Upper bound for a single vacation request. */
	maxVacationDays: 90,
} as const
