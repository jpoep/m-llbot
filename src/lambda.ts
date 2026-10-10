import { timingSafeEqual } from "node:crypto"
import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from "aws-lambda"
import { Config, Effect, Layer, ManagedRuntime, Redacted } from "effect"
import { webhookCallback } from "grammy"
import { type AppRuntime, createBot } from "./bot/bot.ts"
import { tick as tickDomain } from "./domain/tick.ts"
import { transact } from "./services/Household.ts"
import { DynamoStateStore } from "./services/StateStore.ts"
import { LiveTelegram } from "./services/Telegram.ts"
import { webhookSecret } from "./webhookSecret.ts"

const runtime: AppRuntime = ManagedRuntime.make(Layer.mergeAll(DynamoStateStore, LiveTelegram))

type WebhookHandler = (event: APIGatewayProxyEventV2) => Promise<APIGatewayProxyStructuredResultV2>

const SECRET_HEADER = "x-telegram-bot-api-secret-token"

const makeWebhookHandler = Effect.gen(function* () {
	const token = Redacted.value(yield* Config.Redacted("TELEGRAM_BOT_TOKEN"))
	const joinCode = Redacted.value(yield* Config.Redacted("JOIN_CODE"))
	const secret = Buffer.from(webhookSecret(token))
	const bot = createBot({ token, joinCode, runtime })
	const handle = webhookCallback(bot, "aws-lambda-async", {
		secretToken: secret.toString(),
		onTimeout: "return",
		timeoutMilliseconds: 25_000,
	}) as unknown as WebhookHandler
	// grammY calls getMe before it checks the secret; reject strangers without touching Telegram.
	const authorized = (event: APIGatewayProxyEventV2): boolean => {
		const given = Buffer.from(event.headers?.[SECRET_HEADER] ?? "")
		return given.length === secret.length && timingSafeEqual(given, secret)
	}
	return (event: APIGatewayProxyEventV2) =>
		authorized(event) ? handle(event) : Promise.resolve({ statusCode: 401 })
})

// Built once per cold start; `bot.init()` (one getMe call) happens lazily on the first update.
let webhookHandler: Promise<WebhookHandler> | undefined

/** Lambda Function URL target: receives Telegram updates. */
export const webhook = (
	event: APIGatewayProxyEventV2,
): Promise<APIGatewayProxyStructuredResultV2> => {
	webhookHandler ??= runtime.runPromise(makeWebhookHandler)
	return webhookHandler.then((handle) => handle(event))
}

/** EventBridge Scheduler target: runs every minute. */
export const tick = (): Promise<void> =>
	runtime.runPromise(
		transact((state, now) => tickDomain(state, now)).pipe(
			Effect.tap((t) =>
				t.outbox.length > 0
					? Effect.logInfo("Tick delivered messages", { count: t.outbox.length })
					: Effect.void,
			),
			Effect.asVoid,
		),
	)
