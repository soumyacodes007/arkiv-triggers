// Live Telegram test on Tiramisu: a real worker sends a real Telegram message when a rule fires.
//   npm run test:live:telegram
// Needs in .env.local: WORKER_A_PRIVATE_KEY (writes the rule), WORKER_B_PRIVATE_KEY (runs the worker),
// TELEGRAM_BOT_TOKEN (the bot) and TELEGRAM_CHAT_ID (a chat that has pressed Start on the bot).
//
// Checks: the chat ID is stored only sealed (never in plain text on Arkiv), the worker opens it and
// sends the message once, and the receipt records Telegram's message ID.
import { existsSync } from "node:fs"
import { createWalletClient } from "@arkiv-network/sdk"
import { tiramisu } from "@arkiv-network/sdk/chains"
import { type Hex, http } from "viem"
import { privateKeyToAccount } from "viem/accounts"
import { SEALED_PREFIX } from "../../src/schema"
import { createTriggers } from "../../src/sdk"
import { sealForWorker, workerSealKeys } from "../../src/seal"
import { startWorker } from "../../src/worker"

for (const f of [".env.local", ".env"]) if (existsSync(f)) process.loadEnvFile(f)
const keyA = process.env.WORKER_A_PRIVATE_KEY as Hex
const keyB = process.env.WORKER_B_PRIVATE_KEY as Hex
const token = process.env.TELEGRAM_BOT_TOKEN
const chatId = process.env.TELEGRAM_CHAT_ID
if (!keyA || !keyB || !token || !chatId) throw new Error("set WORKER_A_PRIVATE_KEY, WORKER_B_PRIVATE_KEY, TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID in .env.local")
const accessKey = process.env.ARKIV_ACCESS_KEY
const transport = http("https://rpc.tiramisu.db-chain.testnet.arkiv.network", accessKey ? { fetchOptions: { headers: { "X-API-KEY": accessKey } } } : {})
const walletA: any = createWalletClient({ chain: tiramisu, transport, account: privateKeyToAccount(keyA) })
const app = `trg-tg-${Date.now()}`
const t = createTriggers({ wallet: walletA, accessKey, app })
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
let failed = 0
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`)
  if (!ok) failed++
}

// The rule is assigned to worker-b and its chat sealed to worker-b's key: only worker-b can send it.
const workerB = privateKeyToAccount(keyB).address
const head = await t.reader.getBlockNumber()
const rule = await t.createRule({
  name: "Telegram live test",
  trigger: { on: "block", fireAt: head + 20n },
  action: "telegram",
  worker: workerB,
  chat: sealForWorker(chatId, workerSealKeys(keyB).publicKey),
  message: "✅ Arkiv Triggers live test: {rule} fired at {time}",
})
console.log(`rule ${rule.key.slice(0, 10)}… due at block ${head + 20n}`)

const stored = await t.reader.getEntity(rule.key)
const payload = new TextDecoder().decode(stored.payload)
check("the chat is stored sealed, never in plain text", JSON.parse(payload).chat.startsWith(SEALED_PREFIX) && !payload.includes(chatId))

const worker = await startWorker({ privateKey: keyB, accessKey, app, telegramToken: token, telegramLinking: false, pollMs: 3_000, log: (l) => console.log(`  worker: ${l}`) })

const until = Date.now() + 4 * 60_000
let receipts = await t.listReceipts({ rule: rule.key })
while (Date.now() < until && !receipts.length) {
  await sleep(4_000)
  receipts = await t.listReceipts({ rule: rule.key })
}
await sleep(10_000)
receipts = await t.listReceipts({ rule: rule.key })

check("exactly one receipt", receipts.length === 1, receipts.map((r) => `${r.status} ${r.result.error ?? ""}`).join("; "))
const r = receipts[0]
if (r) {
  check("status ok", r.status === "ok", r.result.error ?? "")
  check("the receipt has Telegram's message ID", typeof r.result.messageId === "number", `messageId ${r.result.messageId}`)
  check("fired by worker-b", r.worker.toLowerCase() === workerB.toLowerCase())
  check("fired within 3 blocks of its deadline", r.firedAt - r.deadline <= 3n, `${r.firedAt - r.deadline} blocks late`)
}

await worker.stop()
await t.deleteRule(rule.key).catch(() => undefined)
process.exit(failed ? 1 : 0)
