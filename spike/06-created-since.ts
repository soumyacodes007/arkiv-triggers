// Can a query select only entities created since a block? ($createdAt in a range, as $expiresAt is.)
//   npx tsx spike/06-created-since.ts
import { existsSync } from "node:fs"
import { createPublicClient, str, u64 } from "@arkiv-network/sdk"
import { tiramisu } from "@arkiv-network/sdk/chains"
import { and, eq, gte } from "@arkiv-network/sdk/query"
import { http } from "viem"

for (const f of [".env.local", ".env"]) if (existsSync(f)) process.loadEnvFile(f)
const key = process.env.ARKIV_ACCESS_KEY
const c: any = createPublicClient({ chain: tiramisu, transport: http("https://rpc.tiramisu.db-chain.testnet.arkiv.network", key ? { fetchOptions: { headers: { "X-API-KEY": key } } } : {}) })
const head: bigint = await c.getBlockNumber()
for (const since of [head - 2000n, 0n]) {
  try {
    let n = 0
    for await (const _ of c.select({ key: true }).where(and([eq("type", str("trg.rule")), gte("$createdAt", u64(since))])).limit(200).atBlock(head)) n++
    console.log(`$createdAt >= ${since}: ${n} rules`)
  } catch (e: any) {
    console.log(`$createdAt >= ${since}: error ${(e.shortMessage || e.message).split("\n")[0]}`)
  }
}
