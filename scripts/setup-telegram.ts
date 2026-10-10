/**
 * Points Telegram at the deployed webhook and publishes the command menu.
 * Reads the bot token, join code and Function URL from the Pulumi stack (run after `pulumi up`).
 *   bun run setup-telegram
 */
import { $ } from "bun"
import { Api } from "grammy"
import { COMMANDS } from "../src/bot/bot.ts"
import { webhookSecret } from "../src/webhookSecret.ts"

const infra = new URL("../infra", import.meta.url).pathname

const token = (await $`pulumi config get telegramBotToken --cwd ${infra}`.quiet().text()).trim()
const joinCode = (await $`pulumi config get joinCode --cwd ${infra}`.quiet().text()).trim()
const url = (await $`pulumi stack output webhookUrl --cwd ${infra}`.quiet().text()).trim()

const api = new Api(token)
await api.setWebhook(url, {
	secret_token: webhookSecret(token),
	allowed_updates: ["message", "callback_query"],
	max_connections: 5,
})
await api.setMyCommands([...COMMANDS])
await api.setMyDescription(
	"Erinnert eure WG an Haushaltsaufgaben – und wird abends immer nerviger, bis sie erledigt sind. 🧹",
)
await api.setMyShortDescription("Der nervigste Haushalts-Bot der Welt.")

const me = await api.getMe()
const info = await api.getWebhookInfo()
console.log(`✅ Webhook set: ${info.url} (pending updates: ${info.pending_update_count})`)
console.log(
	`🔑 Invite link (only share with roommates): https://t.me/${me.username}?start=${joinCode}`,
)
