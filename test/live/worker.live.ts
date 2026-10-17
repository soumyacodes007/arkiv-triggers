// Phase 4 end-to-end test on Tiramisu: a real worker fires real rules.
//   npm run test:live:worker   (needs WORKER_A_PRIVATE_KEY with test GLM in .env.local)
//
// Scenarios, all written before the worker starts (only one funded wallet, so no concurrent writes):
//   A. expire → receipt:  a target expiring in about 80 s; the rule fires once after it expires.
//   B. block  → webhook:  a fire block about 60 s out; a local server receives one signed POST.
//   C. expire → receipt on a target deleted early: the rule must be skipped, not fired.
//   D. expire → extend:   1 minute early, extend a permissionless target by 1 day.
import { existsSync } from "node:fs"
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { ExpirationTime, createWalletClient, str } from "@arkiv-network/sdk"
import { tiramisu } from "@arkiv-network/sdk/chains"
import { type Hex, http } from "viem"
import { privateKeyToAccount } from "viem/accounts"
import { createTriggers } from "../../src/sdk"
import { WEBHOOK_HEADERS, verifyWebhook } from "../../src/webhook"
import { startWorker } from "../../src/worker"

for (const f of [".env.local", ".env"]) if (existsSync(f)) process.loadEnvFile(f)
const key = process.env.WORKER_A_PRIVATE_KEY as Hex
const accessKey = process.env.ARKIV_ACCESS_KEY
const transport = http("https://rpc.tiramisu.db-chain.testnet.arkiv.network", accessKey ? { fetchOptions: { headers: { "X-API-KEY": accessKey } } } : {})
const wallet: any = createWalletClient({ chain: tiramisu, transport, account: privateKeyToAccount(key) })
const app = `trg-e2e-${Date.now()}`
const t = createTriggers({ wallet, accessKey, app })
const enc = new TextEncoder()
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
let failed = 0
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`)
  if (!ok) failed++
}

// A local receiver for scenario B (the worker runs with allowLocal for this test only).
const hits: { body: string; sig: string }[] = []
const srv = createServer((req, res) => {
  let body = ""
  req.on("data", (c) => (body += c))
  req.on("end", () => {
    hits.push({ body, sig: String(req.headers[WEBHOOK_HEADERS.signature]) })
    res.end("ok")
  })
})
await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r))
const hookUrl = `http://127.0.0.1:${(srv.address() as AddressInfo).port}/hook`

const target = (label: string, seconds: number, permissionless = false) =>
  wallet.createEntity({
    payload: enc.encode(label),
    contentType: "text/plain",
    attributes: { app: str(app), type: str("e2e.target"), label: str(label) },
    expires: ExpirationTime.fromSeconds(seconds),
    ...(permissionless ? { flags: { permissionlessExtension: true } } : {}),
  }) as Promise<{ entityKey: Hex }>

console.log("setting up targets and rules…")
const ta = await target("A", 80)
const tc = await target("C", 600)
const td = await target("D", 140, true)
const head = await t.reader.getBlockNumber()
const ra = await t.createRule({ name: "A expire→receipt", trigger: { on: "expire", target: ta.entityKey }, action: "receipt" })
const rb = await t.createRule({ name: "B block→webhook", trigger: { on: "block", fireAt: head + 30n }, action: "webhook", url: hookUrl, message: "{rule} fired at {time}" })
const rc = await t.createRule({ name: "C deleted target", trigger: { on: "expire", target: tc.entityKey }, action: "receipt" })
const rd = await t.createRule({ name: "D keep alive", trigger: { on: "expire", target: td.entityKey, offset: 30n }, action: "extend", extendDays: 1 })
await wallet.deleteEntity({ entityKey: tc.entityKey }) // C's target goes away early
const tdBefore = (await t.reader.getEntity(td.entityKey)).expiresAt as bigint
console.log(`rules A ${ra.key.slice(0, 10)} B ${rb.key.slice(0, 10)} C ${rc.key.slice(0, 10)} D ${rd.key.slice(0, 10)}`)

const worker = await startWorker({ privateKey: key, accessKey, app, allowLocal: true, pollMs: 3_000, heartbeatMs: 30_000, log: (l) => console.log(`  worker: ${l}`) })

const want = { [ra.key]: "ok", [rb.key]: "ok", [rc.key]: "skipped", [rd.key]: "ok" } as Record<string, string>
const deadline = Date.now() + 5 * 60_000
let receipts: Awaited<ReturnType<typeof t.listReceipts>> = []
while (Date.now() < deadline) {
  receipts = (await Promise.all(Object.keys(want).map((k) => t.listReceipts({ rule: k as Hex })))).flat()
  if (Object.keys(want).every((k) => receipts.some((r) => r.rule.toLowerCase() === k.toLowerCase()))) break
  await sleep(5_000)
}
await sleep(10_000) // give a duplicate, if any, time to show up
receipts = (await Promise.all(Object.keys(want).map((k) => t.listReceipts({ rule: k as Hex })))).flat()

for (const [k, status] of Object.entries(want)) {
  const mine = receipts.filter((r) => r.rule.toLowerCase() === k.toLowerCase())
  const name = { [ra.key]: "A", [rb.key]: "B", [rc.key]: "C", [rd.key]: "D" }[k]
  check(`${name}: exactly one receipt, status ${status}`, mine.length === 1 && mine[0].status === status, mine.map((r) => `${r.status} firedAt=${r.firedAt} deadline=${r.deadline} ${r.reason}`).join("; ") || "none")
  if (mine[0]) check(`${name}: the receipt's $creator is the worker`, mine[0].worker.toLowerCase() === worker.address.toLowerCase())
}
const a = receipts.find((r) => r.rule.toLowerCase() === ra.key.toLowerCase())
if (a) check("A fired within 10 blocks of its deadline", a.firedAt - a.deadline <= 10n, `${a.firedAt - a.deadline} blocks late`)
check("B: the webhook arrived once", hits.length === 1, `${hits.length} hits`)
if (hits[0]) check("B: the webhook signature verifies", (await verifyWebhook(hits[0].body, hits[0].sig, [worker.address])).ok)
const tdAfter = await t.reader.getEntity(td.entityKey).then((e: any) => e.expiresAt as bigint, () => 0n)
check("D: the target now lives about a day longer", tdAfter > tdBefore + 40_000n, `${tdBefore} → ${tdAfter}`)
const workers = await t.listWorkers()
check("the worker's heartbeat is listed and online", workers.some((w) => w.worker.toLowerCase() === worker.address.toLowerCase() && w.online))

await worker.stop()
srv.close()
console.log(worker.stats())
process.exit(failed ? 1 : 0)
