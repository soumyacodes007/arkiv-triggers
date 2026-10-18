// How long do Arkiv queries take right now, at the head and at past blocks? (friction #15)
//   npx tsx spike/07-query-latency.ts            (uses ARKIV_ACCESS_KEY from .env.local if set)
//   ANON=1 npx tsx spike/07-query-latency.ts     (anonymous)
// Times eth_blockNumber and the same small arkiv_query at the head, 5 blocks back and 500 blocks back.
import { existsSync } from "node:fs"

for (const f of [".env.local", ".env"]) if (existsSync(f)) process.loadEnvFile(f)
const RPC = process.env.ARKIV_RPC_URL ?? "https://rpc.tiramisu.db-chain.testnet.arkiv.network"
const key = process.env.ANON ? undefined : process.env.ARKIV_ACCESS_KEY

async function call(method: string, params: unknown[]) {
  const t = Date.now()
  try {
    const res = await fetch(RPC, {
      method: "POST",
      headers: { "content-type": "application/json", ...(key ? { "X-API-KEY": key } : {}) },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      signal: AbortSignal.timeout(60_000),
    })
    const text = await res.text()
    const quota = res.headers.get("arkiv-quota-used-percent")
    const note = text.includes('"error"') ? text.slice(0, 90) : "ok"
    return { ms: Date.now() - t, status: res.status, note: quota ? `${note} · quota ${quota}%` : note, body: text }
  } catch (e) {
    return { ms: Date.now() - t, status: (e as Error).name, note: (e as Error).message, body: "" }
  }
}

const block = await call("eth_blockNumber", [])
const head = BigInt(JSON.parse(block.body).result)
console.log(`eth_blockNumber            ${String(block.ms).padStart(6)} ms  ${block.status}  head ${head}`)
const query = "type = str('trg.rule')"
for (const [label, at] of [
  ["arkiv_query at head      ", undefined],
  ["arkiv_query at head-5    ", head - 5n],
  ["arkiv_query at head-500  ", head - 500n],
] as const) {
  const r = await call("arkiv_query", [query, { select: { key: true }, limit: 50, ...(at ? { atBlock: `0x${at.toString(16)}` } : {}) }])
  console.log(`${label} ${String(r.ms).padStart(6)} ms  ${r.status}  ${r.note}`)
}
