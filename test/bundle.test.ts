import { afterAll, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { $ } from "bun"
import packageJson from "../package.json"

/**
 * Regression test: minifying identifiers renames `AbortSignal`, which node-fetch (used by grammY on
 * Node) checks by constructor name – every Telegram call then fails and the webhook hangs.
 * Builds a tiny grammY call with the exact production flags and runs it with Node.
 */
const outdir = mkdtempSync(join(tmpdir(), "muellbot-bundle-"))
afterAll(() => rmSync(outdir, { recursive: true, force: true }))

const productionFlags = (): ReadonlyArray<string> => {
	const args = packageJson.scripts.build.split(/\s+/).slice(3) // drop `bun build src/lambda.ts`
	const result: Array<string> = []
	for (let i = 0; i < args.length; i++) {
		const arg = args[i] ?? ""
		if (arg === "--outdir" || arg === "--entry-naming" || arg === "--external") {
			i++
		} else {
			result.push(arg)
		}
	}
	return result
}

describe("production bundle", () => {
	test("can still talk to the Telegram API under Node", async () => {
		const server = Bun.serve({
			port: 0,
			fetch: () =>
				Response.json({
					ok: true,
					result: { id: 1, is_bot: true, first_name: "Probe", username: "probe_bot" },
				}),
		})
		try {
			await $`bun build test/fixtures/fetchProbe.ts ${productionFlags()} --outdir ${outdir} --entry-naming probe.mjs`.quiet()
			const output = await $`node --no-deprecation ${join(outdir, "probe.mjs")}`
				.env({ ...process.env, API_ROOT: `http://localhost:${server.port}` })
				.quiet()
				.text()
			expect(output).toBe("probe_bot")
		} finally {
			server.stop(true)
		}
	}, 30_000)
})
