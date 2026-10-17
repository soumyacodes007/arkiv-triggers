// Checks a worker that is already running somewhere else (Docker, Railway): it must be online and fire
// a rule assigned to it exactly once.
//   DEPLOYED_WORKER=0x... npm run test:live:deployed   (defaults to WORKER_B_ADDRESS)
// The rule is written by worker-a's wallet (WORKER_A_PRIVATE_KEY), so the deployed worker must use another key.
import { existsSync } from "node:fs"
import { createWalletClient } from "@arkiv-network/sdk"
import { tiramisu } from "@arkiv-network/sdk/chains"
import { type Hex, http } from "viem"
import { privateKeyToAccount } from "viem/accounts"
import { createTriggers } from "../../src/sdk"

for (const f of [".env.local", ".env"]) if (existsSync(f)) process.loadEnvFile(f)
const target = (process.env.DEPLOYED_WORKER ?? process.env.WORKER_B_ADDRESS) as Hex
const accessKey = process.env.ARKIV_ACCESS_KEY
const transport = http("https://rpc.tiramisu.db-chain.testnet.arkiv.network", accessKey ? { fetchOptions: { headers: { "X-API-KEY": accessKey } } } : {})
const wallet: any = createWalletClient({ chain: tiramisu, transport, account: privateKeyToAccount(process.env.WORKER_A_PRIVATE_KEY as Hex) })
const t = createTriggers({ wallet, accessKey, app: `trg-deployed-${Date.now()}` })
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
let failed = 0
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`)
  if (!ok) failed++
}

const workers = await t.listWorkers()
const me = workers.find((w) => w.worker.toLowerCase() === target.toLowerCase())
check("the deployed worker has a live heartbeat", !!me?.online, me ? `last block ${me.lastBlock}` : "no heartbeat found")

const head = await t.reader.getBlockNumber()
const fireAt = head + 20n
const rule = await t.createRule({ name: "deployed smoke", trigger: { on: "block", fireAt }, action: "receipt", worker: target })
console.log(`rule ${rule.key} assigned to ${target}, fires at block ${fireAt} (head ${head})`)

const deadline = Date.now() + 4 * 60_000
let receipts: Awaited<ReturnType<typeof t.listReceipts>> = []
while (Date.now() < deadline) {
  receipts = await t.listReceipts({ rule: rule.key })
  if (receipts.length) break
  await sleep(4_000)
}
await sleep(10_000) // give a duplicate, if any, time to show up
receipts = await t.listReceipts({ rule: rule.key })
const r = receipts[0]
check("exactly one receipt", receipts.length === 1, `${receipts.length} found`)
check("receipt status is ok", r?.status === "ok", r?.status)
check("receipt signed by the deployed worker", r?.worker.toLowerCase() === target.toLowerCase(), r?.worker)
if (r) console.log(`      fired at block ${r.firedAt}, ${r.firedAt - fireAt} blocks after the deadline`)

await t.deleteRule(rule.key).catch(() => {}) // tidy up; the rule would expire on its own anyway
console.log(failed ? `\n${failed} check(s) failed` : "\nall checks passed")
process.exit(failed ? 1 : 0)
