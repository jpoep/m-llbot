export interface Button {
	readonly text: string
	readonly data: string
}

export type Keyboard = ReadonlyArray<ReadonlyArray<Button>>

/** A message to send. Texts use Telegram's HTML parse mode. */
export interface Send {
	readonly _tag: "Send"
	readonly chatId: number
	readonly text: string
	readonly keyboard: Keyboard
}

/** Replaces the text and keyboard of a message the bot sent earlier. */
export interface Edit {
	readonly _tag: "Edit"
	readonly chatId: number
	readonly messageId: number
	readonly text: string
	readonly keyboard: Keyboard
}

export type Outgoing = Send | Edit

export const send = (chatId: number, text: string, keyboard: Keyboard = []): Send => ({
	_tag: "Send",
	chatId,
	text,
	keyboard,
})

export const edit = (
	chatId: number,
	messageId: number,
	text: string,
	keyboard: Keyboard = [],
): Edit => ({ _tag: "Edit", chatId, messageId, text, keyboard })

/** One button per row – the most readable layout on phones. */
export const column = (buttons: ReadonlyArray<Button>): Keyboard => buttons.map((b) => [b])
