import { encodeCallback } from "./callbacks.ts"
import type { Task } from "./model.ts"
import type { Button } from "./outbox.ts"
import { taskButtonLabel } from "./texts.ts"

/** "Done" plus "reschedule" for one task – the two things people actually want from a reminder. */
export const taskActionRow = (task: Task): ReadonlyArray<Button> => [
	{
		text: `Erledigt: ${taskButtonLabel(task)}`,
		data: encodeCallback({ _tag: "Done", taskId: task.id, index: task.current.index }),
	},
	{
		text: "Verschieben",
		data: encodeCallback({ _tag: "RescheduleStart", taskId: task.id, index: task.current.index }),
	},
]

export const jokerButton = (task: Task): Button => ({
	text: `Joker spielen: ${taskButtonLabel(task)}`,
	data: encodeCallback({ _tag: "Joker", taskId: task.id, index: task.current.index }),
})
