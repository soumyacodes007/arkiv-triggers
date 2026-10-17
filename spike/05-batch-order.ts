// Does executeBatch return createdEntities in the order of `creates`? (friction #9)
// The worker batches claims, receipts and its heartbeat into one transaction and maps keys back by index.
//   npx tsx spike/05-batch-order.ts   (uses WORKER_B_PRIVATE_KEY)
import { ExpirationTime, str } from "@arkiv-network/sdk"
import { SPIKE_APP, check, publicClient, walletFor } from "./lib"

const wallet = walletFor("WORKER_B_PRIVATE_KEY")
const labels = ["zz", "aa", "mm", "bb", "yy"] // deliberately not sorted
const res = await wallet.executeBatch({
  creates: labels.map((l) => ({ payload: new Uint8Array(), contentType: "text/plain", attributes: { app: str(SPIKE_APP), label: str(l) }, expires: ExpirationTime.fromSeconds(60) })),
} as any)
const got: string[] = []
for (const k of res.createdEntities) got.push(String(((await publicClient.getEntity(k)).attributes as any).label.value))
console.log(`sent ${labels.join(",")}  got ${got.join(",")}`)
check("createdEntities[i] is the entity from creates[i]", got.join() === labels.join())
