// Open question 1: does `lte` work on our own u64 attributes (not just $expiresAt)?
// Open question 2: what exact shape do attributes have in query results?
// Also checks the bare-number trap: a bare number is an i32, so it never matches a u64 attribute.
//   npx tsx spike/01-u64-range.ts
import { ExpirationTime, str, u64 } from "@arkiv-network/sdk"
import { and, eq, gte, lte } from "@arkiv-network/sdk/query"
import { SPIKE_APP, balance, check, publicClient, walletFor } from "./lib"

const wallet = walletFor("WORKER_A_PRIVATE_KEY")
const before = await balance(wallet.account.address)
const head = await publicClient.getBlockNumber()
const run = `r${Date.now()}`
const fireat = head + 1_000n

const { entityKey, txHash } = await wallet.createEntity({
  payload: new TextEncoder().encode(JSON.stringify({ name: "spike rule" })),
  contentType: "application/json",
  attributes: { app: SPIKE_APP, type: "trg.rule", run, on: "block", fireat: u64(fireat), offset: u64(0) },
  expires: ExpirationTime.fromMinutes(15),
})
console.log(`created ${entityKey} in ${txHash}`)

const base = [eq("app", str(SPIKE_APP)), eq("run", str(run))]
const find = async (...extra: any[]) => {
  const out: any[] = []
  for await (const e of publicClient
    .select({ key: true, creator: true, owner: true, createdAt: true, expiresAt: true, attributes: true })
    .where(and([...base, ...extra]))
    .limit(10)
    .atBlock(await publicClient.getBlockNumber()))
    out.push(e)
  return out
}

const due = await find(lte("fireat", u64(head + 2_000n)))
check("lte on own u64 attribute matches", due.length === 1, `${due.length} result`)
const notDue = await find(lte("fireat", u64(head + 500n)))
check("lte on own u64 attribute excludes later values", notDue.length === 0, `${notDue.length} results`)
const window = await find(gte("fireat", u64(head)), lte("fireat", u64(head + 2_000n)))
check("gte + lte range on own u64 attribute", window.length === 1)

let bare = -1
try {
  bare = (await find(lte("fireat", Number(head + 2_000n) as any))).length
} catch (e) {
  console.log(`bare number refused: ${(e as Error).message.slice(0, 160)}`)
}
check("bare number does NOT match a u64 attribute (i32 trap)", bare <= 0, bare === -1 ? "SDK refused it" : `${bare} results`)

const e = due[0]
console.log("\nattribute shape in query results:")
for (const [name, value] of Object.entries(e?.attributes ?? {})) {
  const v = value as any
  console.log(`  ${name}: type=${v?.type ?? typeof v} value=${typeof v?.value === "bigint" ? `${v.value}n` : JSON.stringify(v?.value)} keys=[${Object.keys(v ?? {}).join(",")}]`)
}
console.log(`system fields: creator=${e?.creator} owner=${e?.owner} createdAt=${e?.createdAt} expiresAt=${e?.expiresAt}`)

await wallet.deleteEntity({ entityKey })
const after = await balance(wallet.account.address)
console.log(`\ncost of create + delete: ${(before - after).toFixed(6)} GLM (balance now ${after.toFixed(4)})`)
