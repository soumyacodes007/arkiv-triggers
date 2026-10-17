// Counts every JSON-RPC call a worker makes, by method, for a fixed time; for sizing a worker's quota.
//   node spike/count-worker.mjs <seconds>   (worker key, access key and bot token from .env.local)
import { existsSync } from "node:fs"
for (const f of [".env.local"]) if (existsSync(f)) process.loadEnvFile(f)
const counts = {}
const real = globalThis.fetch
globalThis.fetch = async (url, init) => {
  try {
    for (const m of [].concat(JSON.parse(init?.body ?? "null") ?? [])) if (m?.method) counts[m.method] = (counts[m.method] ?? 0) + 1
  } catch {}
  return real(url, init)
}
const { startWorker } = await import("../dist/worker.js")
const secs = Number(process.argv[2] ?? 300)
const w = await startWorker({ privateKey: process.env.WORKER_B_PRIVATE_KEY, accessKey: process.env.ARKIV_ACCESS_KEY, telegramToken: process.env.TELEGRAM_BOT_TOKEN, mode: "any", log: (l) => /linking/.test(l) || console.log("  " + l) })
setTimeout(async () => {
  await w.stop()
  const q = counts.arkiv_query ?? 0
  console.log(JSON.stringify(counts))
  console.log(`arkiv_query: ${q} in ${secs}s = ${((q / secs) * 60).toFixed(1)}/min = ${Math.round((q / secs) * 86400)}/day`)
  process.exit(0)
}, secs * 1000)
