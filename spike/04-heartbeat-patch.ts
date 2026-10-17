// How do we renew a heartbeat in place? (friction #7)
//   npx tsx spike/04-heartbeat-patch.ts
// 1. patchEntity with an `attributes` key: the key is silently ignored and the call fails with "nothing to apply".
// 2. patchEntity with `set`: works, for a partial or a full attribute set.
// 3. executeBatch with a patch and an extension of the same entity: works, one transaction.
import { ExpirationTime } from "@arkiv-network/sdk"
import { heartbeatAttributes, heartbeatToCreate } from "../src/schema"
import { publicClient, walletFor } from "./lib"

const wallet = walletFor("WORKER_A_PRIVATE_KEY")
const input = { version: "spike", mode: "any" as const, lastBlock: 1n, actions: ["receipt" as const], sealKey: "0x00" as const }
const { entityKey } = await wallet.createEntity(heartbeatToCreate(input))
console.log("created", entityKey)

async function attempt(label: string, run: () => Promise<{ txHash: string }>) {
  try {
    console.log(`${label}: ok ${(await run()).txHash}`)
  } catch (e) {
    console.log(`${label}: FAILED ${(e as Error).message.slice(0, 200)}`)
  }
}

await attempt("PATCH with `attributes` (wrong key, ignored)", () =>
  wallet.patchEntity({ entityKey, attributes: heartbeatAttributes({ ...input, lastBlock: 2n }) } as any),
)
await attempt("PATCH with `set`, changed attribute only", () =>
  wallet.patchEntity({ entityKey, set: { lastblock: heartbeatAttributes({ ...input, lastBlock: 3n }).lastblock } } as any),
)
await attempt("PATCH with `set`, full attribute set", () => wallet.patchEntity({ entityKey, set: heartbeatAttributes({ ...input, lastBlock: 4n }) } as any))
await attempt("BATCH patch + extend of the same entity", () =>
  wallet.executeBatch({
    patches: [{ entityKey, set: heartbeatAttributes({ ...input, lastBlock: 5n }) }],
    extensions: [{ entityKey, expires: ExpirationTime.fromSeconds(300) }],
  } as any),
)
const after = await publicClient.getEntity(entityKey)
console.log("lastblock now", (after.attributes as any).lastblock, "expiresAt", after.expiresAt)
await wallet.deleteEntity({ entityKey })
