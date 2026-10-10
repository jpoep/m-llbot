import { Config, Context, Effect, Layer, Redacted, Ref } from "effect"
import { Api, InlineKeyboard } from "grammy"
import type { Keyboard, Outgoing } from "../domain/outbox.ts"

/** Delivers the outbox of a transition. Delivery is best effort: failures are logged, never raised. */
export class Telegram extends Context.Service<
	Telegram,
	{ readonly deliver: (messages: ReadonlyArray<Outgoing>) => Effect.Effect<void> }
>()("Telegram") {}

const toInlineKeyboard = (keyboard: Keyboard): InlineKeyboard =>
	InlineKeyboard.from(keyboard.map((row) => row.map((b) => InlineKeyboard.text(b.text, b.data))))

const deliverOne = (api: Api, message: Outgoing): Promise<unknown> => {
	const options = {
		parse_mode: "HTML",
		link_preview_options: { is_disabled: true },
		reply_markup: toInlineKeyboard(message.keyboard),
	} as const
	return message._tag === "Send"
		? api.sendMessage(message.chatId, message.text, options)
		: api.editMessageText(message.chatId, message.messageId, message.text, options)
}

export const makeTelegramApi = Effect.map(
	Config.Redacted("TELEGRAM_BOT_TOKEN"),
	(token) => new Api(Redacted.value(token)),
)

export const LiveTelegram = Layer.effect(
	Telegram,
	Effect.map(makeTelegramApi, (api) => ({
		deliver: (messages) =>
			Effect.forEach(
				messages,
				(message) =>
					Effect.tryPromise(() => deliverOne(api, message)).pipe(
						Effect.catch((error) =>
							Effect.logWarning("Telegram delivery failed", {
								chatId: message.chatId,
								error: String(error),
							}),
						),
					),
				{ concurrency: 5, discard: true },
			),
	})),
)

/** Records everything that would have been sent. */
export const RecordingTelegram = Effect.gen(function* () {
	const sent = yield* Ref.make<ReadonlyArray<Outgoing>>([])
	const layer = Layer.succeed(Telegram)({
		deliver: (messages) => Ref.update(sent, (all) => [...all, ...messages]),
	})
	return { sent, layer }
})
