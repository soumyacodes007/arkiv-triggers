// Network test on Tiramisu: two real workers (worker-a and worker-b wallets) sharing one set of rules.
//   npm run test:live:network   (needs WORKER_A_PRIVATE_KEY and WORKER_B_PRIVATE_KEY with test GLM)
//
// Everything is written by worker-a's wallet before worker-a starts (one wallet, one writer at a time).
//   T. takeover: a rule due in ~20 s with a live claim from worker-a, which is not running (a crashed
//      worker). Worker-b may not fire it while that lease is live; worker-a, back up, may resume its own
//      lease (extending it if short). Either way exactly one worker fires it.
//   O. downtime: 3 rules assigned only to worker-a, due while it is down. It fires them on start.
//   R. race: 20 rules (NET_RULES) due while both workers run (2 webhook, the rest receipt). Each fires exactly once.
import { existsSync } from "node:fs"
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { createWalletClient } from "@arkiv-network/sdk"
import { tiramisu } from "@arkiv-network/sdk/chains"
import { type Hex, http } from "viem"
import { privateKeyToAccount } from "viem/accounts"
import { claimToCreate } from "../../src/schema"
import { createTriggers } from "../../src/sdk"
import { WEBHOOK_HEADERS, verifyWebhook } from "../../src/webhook"
import { type WorkerHandle, startWorker } from "../../src/worker"

for (const f of [".env.local", ".env"]) if (existsSync(f)) process.loadEnvFile(f)
const keyA = process.env.WORKER_A_PRIVATE_KEY as Hex
const keyB = process.env.WORKER_B_PRIVATE_KEY as Hex
const accessKey = process.env.ARKIV_ACCESS_KEY
const transport = http("https://rpc.tiramisu.db-chain.testnet.arkiv.network", accessKey ? { fetchOptions: { headers: { "X-API-KEY": accessKey } } } : {})
const accountA = privateKeyToAccount(keyA)
const walletA: any = createWalletClient({ chain: tiramisu, transport, account: accountA })
const app = `trg-net-${Date.now()}`
const t = createTriggers({ wallet: walletA, accessKey, app })
/** How many race rules, and over how many consecutive blocks they come due (NET_RULES=100 for a load run). */
const RACE = Number(process.env.NET_RULES ?? 20)
const SPREAD = Math.max(6, Math.ceil(RACE / 4))
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const lower = (s: string) => s.toLowerCase()
let failed = 0
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`)
  if (!ok) failed++
}

const hits: { body: string; sig: string; event: string }[] = []
const srv = createServer((req, res) => {
  let body = ""
  req.on("data", (c) => (body += c))
  req.on("end", () => {
    hits.push({ body, sig: String(req.headers[WEBHOOK_HEADERS.signature]), event: String(req.headers[WEBHOOK_HEADERS.event]) })
    res.end("ok")
  })
})
await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r))
const hookUrl = `http://127.0.0.1:${(srv.address() as AddressInfo).port}/hook`

console.log("setting up rules…")
const head = await t.reader.getBlockNumber()
const takeover = await t.createRule({ name: "T takeover", trigger: { on: "block", fireAt: head + 10n }, action: "receipt" })
const own = await t.createRules(
  [0, 1, 2].map((i) => ({ name: `O own ${i}`, trigger: { on: "block" as const, fireAt: head + 25n + BigInt(i) }, action: "receipt" as const, worker: accountA.address })),
)
const raceInputs = Array.from({ length: RACE }, (_, i) =>
  i < 2
    ? { name: `R hook ${i}`, trigger: { on: "block" as const, fireAt: head + 75n + BigInt(i) }, action: "webhook" as const, url: hookUrl, message: "{rule} at {time}" }
    : { name: `R ${i}`, trigger: { on: "block" as const, fireAt: head + 70n + BigInt(i % SPREAD) }, action: "receipt" as const },
)
const race = { keys: [] as Hex[] }
for (let i = 0; i < raceInputs.length; i += 25) race.keys.push(...(await t.createRules(raceInputs.slice(i, i + 25))).keys)
// worker-a "crashes" right after claiming T: a live claim that nobody will act on.
const fake = await walletA.createEntity(claimToCreate(takeover.key, accountA.address, head + 10n))
const fakeClaim = await t.reader.getEntity(fake.entityKey)
console.log(`head ${head}; fake claim on T lives until block ${fakeClaim.expiresAt}`)

const logFor = (name: string) => (l: string) => console.log(`  ${name}: ${l}`)
const common = { accessKey, app, allowLocal: true, pollMs: 3_000, heartbeatMs: 30_000 }
const workerB = await startWorker({ ...common, privateKey: keyB, log: logFor("B") })

// Start worker-a only after its own rules are past due (~head + 30).
while ((await t.reader.getBlockNumber().catch(() => 0n)) < head + 32n) await sleep(2_000) // a network blip is not a failure
const workerA: WorkerHandle = await startWorker({ ...common, privateKey: keyA, log: logFor("A") })

const allKeys = [takeover.key, ...own.keys, ...race.keys].map(lower)
const receiptsNow = async () => (await t.listReceipts({ creator: accountA.address })).filter((r) => allKeys.includes(lower(r.rule)))
const until = Date.now() + (6 + Math.ceil(RACE / 50)) * 60_000
let receipts = await receiptsNow()
while (Date.now() < until && new Set(receipts.map((r) => lower(r.rule))).size < allKeys.length) {
  await sleep(5_000)
  receipts = await receiptsNow()
}
await sleep(20_000) // time for any duplicate to land
receipts = await receiptsNow()

const by = (k: string) => receipts.filter((r) => lower(r.rule) === lower(k))
const A = lower(workerA.address)
const B = lower(workerB.address)

const tr = by(takeover.key)
check("T: exactly one receipt", tr.length === 1, tr.map((r) => `${r.status} by ${r.worker.slice(0, 8)} at ${r.firedAt}`).join("; "))
if (tr[0]) {
  const byHolder = lower(tr[0].worker) === A
  check(
    "T: resumed by the lease holder, or fired by another worker only after the lease lapsed",
    byHolder || tr[0].firedAt >= (fakeClaim.expiresAt as bigint),
    `${byHolder ? "worker-a resumed its own lease" : "worker-b took over"}; fired ${tr[0].firedAt}, lease ended ${fakeClaim.expiresAt}`,
  )
}

for (const k of own.keys) {
  const rs = by(k)
  check(`O ${k.slice(0, 8)}: one receipt, fired by worker-a after its downtime`, rs.length === 1 && lower(rs[0].worker) === A, rs.map((r) => `${r.status} by ${r.worker.slice(0, 8)} late ${r.firedAt - r.deadline}`).join("; "))
}

const counts = race.keys.map((k) => by(k).length)
check(`R: all ${RACE} rules fired`, counts.every((c) => c >= 1), `${counts.filter((c) => c >= 1).length}/${RACE}`)
check("R: zero duplicates", counts.every((c) => c <= 1), `${counts.reduce((a, c) => a + Math.max(0, c - 1), 0)} duplicates`)
const raceReceipts = race.keys.flatMap(by)
const fromA = raceReceipts.filter((r) => lower(r.worker) === A).length
console.log(`      split: worker-a fired ${fromA}, worker-b fired ${raceReceipts.length - fromA}`)
check("R: every receipt ok", raceReceipts.every((r) => r.status === "ok"))
const late = raceReceipts.map((r) => Number(r.firedAt - r.deadline)).sort((a, b) => a - b)
console.log(`      blocks late: median ${late[Math.floor(late.length / 2)]}, max ${late[late.length - 1]}`)
check("R: 95% fired within 3 blocks of their deadline", late.filter((l) => l <= 3).length >= Math.ceil(late.length * 0.95), RACE <= 30 ? late.join(",") : `${late.filter((l) => l <= 3).length}/${late.length}`)

check("R: each webhook arrived exactly once", hits.length === 2 && new Set(hits.map((h) => h.event)).size === 2, `${hits.length} hits`)
for (const h of hits) check("R: webhook signed by one of the two workers", (await verifyWebhook(h.body, h.sig, [workerA.address, workerB.address])).ok)

const workers = await t.listWorkers()
check("both heartbeats are listed and online", [A, B].every((w) => workers.some((x) => lower(x.worker) === w && x.online)))

await Promise.all([workerA.stop(), workerB.stop()])
srv.close()
console.log("A", workerA.stats(), "\nB", workerB.stats())
process.exit(failed ? 1 : 0)
