import { createHash } from "node:crypto"

/**
 * Secret Telegram echoes in `X-Telegram-Bot-Api-Secret-Token` on every webhook call. Derived from
 * the bot token so there is no extra secret to manage; anyone who can forge it already owns the bot.
 */
export const webhookSecret = (botToken: string): string =>
	createHash("sha256").update(`muellbot-webhook:${botToken}`).digest("hex")
