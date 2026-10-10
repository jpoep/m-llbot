/**
 * Points Telegram at the deployed webhook and publishes the command menu.
 * Reads the bot token and Function URL from the Pulumi stack (run after `pulumi up`).
 * Never touches the join code: this runs in CI, whose logs are public.
 *   bun run setup-telegram
 */
import { $ } from "bun"
import { Api } from "grammy"
import { COMMANDS } from "../src/bot/bot.ts"
import { webhookSecret } from "../src/webhookSecret.ts"

const infra = new URL("../infra", import.meta.url).pathname

const token = (await $`pulumi config get telegramBotToken --cwd ${infra}`.quiet().text()).trim()
const url = (await $`pulumi stack output webhookUrl --cwd ${infra}`.quiet().text()).trim()

const api = new Api(token)
await api.setWebhook(url, {
	secret_token: webhookSecret(token),
	allowed_updates: ["message", "callback_query"],
	max_connections: 5,
})
await api.setMyCommands([...COMMANDS])
await api.setMyDescription(
	"Erinnert eure WG an Haushaltsaufgaben und wird abends zunehmend lästig, bis sie erledigt sind.",
)
await api.setMyShortDescription("Haushaltsaufgaben, mit Nachdruck.")

const info = await api.getWebhookInfo()
console.log(`Webhook set: ${info.url} (pending updates: ${info.pending_update_count})`)
console.log(
	"Invite link: deliberately not printed here (CI logs are public). Locally: bun run invite",
)
