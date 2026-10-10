/**
 * Prints the invite link. Deliberately a separate, local-only command: the link contains the join
 * code, and CI logs of this public repository are public.
 *   bun run invite
 */
import { $ } from "bun"
import { Api } from "grammy"

const infra = new URL("../infra", import.meta.url).pathname
const token = (await $`pulumi config get telegramBotToken --cwd ${infra}`.quiet().text()).trim()
const joinCode = (await $`pulumi config get joinCode --cwd ${infra}`.quiet().text()).trim()
const me = await new Api(token).getMe()
console.log(
	`Invite link (only share with roommates): https://t.me/${me.username}?start=${joinCode}`,
)
