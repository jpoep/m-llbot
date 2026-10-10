// Bundled by test/bundle.test.ts with the production build flags and executed with Node.
import { Api } from "grammy"

const me = await new Api("123:test", { apiRoot: process.env["API_ROOT"] ?? "" }).getMe()
process.stdout.write(me.username)
