// Open question 4: when two workers claim the same rule, can "oldest claim wins" be decided from
// what a query returns? Two claims written in the same block have the same $createdAt, and queries
// return no transaction or log index, so the tie needs a deterministic second key.
// This run uses one funded wallet: two claims in one batch (same block) plus one in a later block.
// The two-wallet version needs a second funded worker wallet (WORKER_B_PRIVATE_KEY).
//   npx tsx spike/03-claim-race.ts
import { ExpirationTime, str } from "@arkiv-network/sdk"
import { and, eq } from "@arkiv-network/sdk/query"
import { SPIKE_APP, balance, check, publicClient, walletFor } from "./lib"

const enc = new TextEncoder()
const rule = `0xrule${Date.now()}`
const claim = (worker: string) => ({
  payload: enc.encode(""),
  contentType: "text/plain",
  attributes: { app: SPIKE_APP, type: "trg.claim", rule: str(rule), worker: str(worker) },
  expires: ExpirationTime.fromSeconds(60),
})

async function claimsFor() {
  const out: { key: string; createdAt: bigint; worker: string; expiresAt: bigint }[] = []
  for await (const e of publicClient
    .select({ key: true, createdAt: true, expiresAt: true, attributes: true })
    .where(and(eq("app", str(SPIKE_APP)), eq("type", str("trg.claim")), eq("rule", str(rule))))
    .limit(50)
    .atBlock(await publicClient.getBlockNumber()))
    out.push({ key: e.key!, createdAt: e.createdAt!, expiresAt: e.expiresAt!, worker: String(e.attributes!.worker.value) })
  return out
}

/** The winner: earliest $createdAt, then the lowest entity key. Every worker computes the same answer. */
const winner = (cs: { key: string; createdAt: bigint }[]) =>
  [...cs].sort((a, b) => (a.createdAt === b.createdAt ? (a.key < b.key ? -1 : 1) : a.createdAt < b.createdAt ? -1 : 1))[0]

const a = walletFor("WORKER_A_PRIVATE_KEY")
const same = await a.executeBatch({ creates: [claim("worker-x"), claim("worker-y")] })
const later = await a.createEntity(claim("worker-z"))
console.log(`batch ${same.txHash}, later ${later.txHash}`)

const cs = await claimsFor()
for (const c of cs) console.log(`  claim ${c.key.slice(0, 12)}… by ${c.worker} createdAt=${c.createdAt} lives ${c.expiresAt - c.createdAt} blocks`)
const sameBlock = cs.filter((c) => c.worker !== "worker-z")
check("claims in one batch share a $createdAt (a real tie)", sameBlock.length === 2 && sameBlock[0].createdAt === sameBlock[1].createdAt)
const w = winner(cs)
check("winner is from the earliest block, tie broken by key", w.createdAt === sameBlock[0]?.createdAt && cs.find((c) => c.key === w.key)?.worker !== "worker-z")
check("a 60 s claim lives about 30 blocks", cs.every((c) => Number(c.expiresAt - c.createdAt) >= 29 && Number(c.expiresAt - c.createdAt) <= 31))

const b = process.env.WORKER_B_PRIVATE_KEY ? walletFor("WORKER_B_PRIVATE_KEY") : undefined
if (b && (await balance(b.account.address)) > 0) {
  const [r1, r2] = await Promise.all([a.createEntity(claim("wallet-a")), b.createEntity(claim("wallet-b"))])
  console.log(`two-wallet race: ${r1.txHash} vs ${r2.txHash}`)
  const all = await claimsFor()
  const racers = all.filter((c) => c.worker.startsWith("wallet-"))
  console.log(racers.map((c) => `${c.worker}@${c.createdAt}`).join(", "), "→ winner", all.find((c) => c.key === winner(racers).key)?.worker)
  check("two wallets agree on one winner", racers.length === 2)
} else {
  console.log("SKIP  two-wallet race: WORKER_B has no test GLM yet")
}
