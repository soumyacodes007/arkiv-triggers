// Phase 3 live test on Tiramisu: create, list, watch and delete rules with the SDK.
//   npm run test:live:sdk      (needs WORKER_A_PRIVATE_KEY with test GLM in .env.local)
import { existsSync } from "node:fs"
import { createWalletClient } from "@arkiv-network/sdk"
import { tiramisu } from "@arkiv-network/sdk/chains"
import { type Hex, http } from "viem"
import { privateKeyToAccount } from "viem/accounts"
import { createTriggers } from "../../src/sdk"

for (const f of [".env.local", ".env"]) if (existsSync(f)) process.loadEnvFile(f)
const key = process.env.WORKER_A_PRIVATE_KEY as Hex
const accessKey = process.env.ARKIV_ACCESS_KEY
const transport = http("https://rpc.tiramisu.db-chain.testnet.arkiv.network", accessKey ? { fetchOptions: { headers: { "X-API-KEY": accessKey } } } : {})
const wallet = createWalletClient({ chain: tiramisu, transport, account: privateKeyToAccount(key) })
const me = wallet.account.address
const app = `trg-live-${Date.now()}`
const t = createTriggers({ wallet: wallet as any, accessKey, app })

let failed = 0
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`)
  if (!ok) failed++
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

const clock = await t.clock()
const drift = Math.abs(clock.timeMs - Date.now())
check("getBlockTiming gives a usable clock", drift < 60_000, `block ${clock.block}, drift ${Math.round(drift / 1000)} s, ${clock.blockSeconds} s/block`)
const fireAt = await t.toBlock(Date.now() + 20 * 60_000)

const ruleEvents: string[] = []
const statuses: string[] = []
const stop = t.watch({ creator: me, onRule: (r) => ruleEvents.push(r.key), onStatus: (s) => statuses.push(s), onError: (e) => console.log(`watch error: ${e.message}`) })
await sleep(4_000)

const one = await t.createRule({ name: "SDK live test", trigger: { on: "block", fireAt }, action: "receipt" })
console.log(`created ${one.key}`)
for (let i = 0; i < 30 && !ruleEvents.includes(one.key); i++) await sleep(1_000)
check("watch() reports the new rule over WebSocket", ruleEvents.includes(one.key), `statuses: ${statuses.join(",")}`)

const batch = await t.createRules([
  { name: "batch A", trigger: { on: "block", fireAt: fireAt + 10n }, action: "receipt" },
  { name: "batch B", trigger: { on: "block", fireAt: fireAt + 20n }, action: "webhook", url: "https://example.com/hook" },
])
check("createRules writes several rules in one transaction", batch.keys.length === 2, batch.txHash)

// A query right after a write can miss it for a block or two (arkiv/friction.md #5).
let listed: string[] = []
for (let i = 0; i < 10 && ![one.key, ...batch.keys].every((k) => listed.includes(k)); i++) {
  if (i) await sleep(1_000)
  listed = (await t.listRules({ creator: me, app })).map((r) => r.key)
}
check("listRules finds all three", [one.key, ...batch.keys].every((k) => listed.includes(k)), `${listed.length} listed`)

const audit = await t.getRule(one.key)
check("getRule returns the rule, its deadline and an empty audit trail", audit?.status === "active" && audit.deadline === fireAt && audit.receipts.length === 0)

let refused = ""
try {
  await t.createRule({ trigger: { on: "expire", target: `0x${"00".repeat(32)}` }, action: "receipt" })
} catch (e) {
  refused = (e as Error).message
}
check("an expire rule on a missing target is refused before spending a transaction", /not found/.test(refused))

for (const k of [one.key, ...batch.keys]) await t.deleteRule(k)
// A query right after a delete can still see the entity for a block or two (arkiv/friction.md #5).
let after = -1
for (let i = 0; i < 10 && after !== 0; i++) {
  after = (await t.listRules({ creator: me, app })).length
  if (after) await sleep(1_000)
}
check("deleteRule removes them", after === 0, `${after} left`)

stop()
process.exit(failed ? 1 : 0)
