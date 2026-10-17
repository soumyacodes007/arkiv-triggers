// Open question 5: after a restart, does watching from the last saved block replay a delete that
// happened while the worker was down? Also: does a live WebSocket watch (no fromBlock) see a create,
// and does an entity reaching its expiry emit any event at all?
//   npx tsx spike/02-replay-events.ts
import { ExpirationTime, str } from "@arkiv-network/sdk"
import { SPIKE_APP, check, publicClient, sleep, socketClient, walletFor } from "./lib"

const wallet = walletFor("WORKER_A_PRIVATE_KEY")
const enc = new TextEncoder()
const mk = (label: string, expires = ExpirationTime.fromMinutes(15)) =>
  wallet.createEntity({
    payload: enc.encode(label),
    contentType: "text/plain",
    attributes: { app: SPIKE_APP, type: "spike.event", label: str(label) },
    expires,
  })

// 1. A live WebSocket watch sees a create as it happens.
const live: string[] = []
const ws = socketClient()
const stopLive = ws.watchEntityEvents({
  onEntityCreated: (e: any) => live.push(String(e.entityKey).toLowerCase()),
  onError: (err: Error) => console.log(`live watch error: ${err.message}`),
})
await sleep(3_000)
const liveOne = await mk("live")
for (let i = 0; i < 20 && !live.includes(liveOne.entityKey.toLowerCase()); i++) await sleep(1_000)
check("live WebSocket watch (no fromBlock) sees the create", live.includes(liveOne.entityKey.toLowerCase()))
stopLive()

// 2. "Worker down": remember the block, then create and delete while nobody is watching.
const saved = await publicClient.getBlockNumber()
const doomed = await mk("deleted-while-down")
await wallet.deleteEntity({ entityKey: doomed.entityKey })
const short = await mk("expires-while-down", ExpirationTime.fromBlocks(5))
console.log(`saved block ${saved}; created+deleted ${doomed.entityKey}; short-lived ${short.entityKey}`)
await sleep(25_000) // let the short-lived entity pass its expiry block

// 3. "Restart": replay from the saved block over plain HTTP polling.
const seen: { name: string; key: string }[] = []
const replay = publicClient.watchEntityEvents({
  fromBlock: saved,
  onEvent: (e: any) => seen.push({ name: e.eventName ?? e.type ?? "?", key: String(e.entityKey).toLowerCase() }),
  onError: (err: Error) => console.log(`replay error: ${err.message}`),
})
await sleep(15_000)
replay()
const about = (key: string) => seen.filter((s) => s.key === key.toLowerCase()).map((s) => s.name)
console.log("replayed events for the deleted entity:", about(doomed.entityKey))
console.log("replayed events for the short-lived entity:", about(short.entityKey))
check("replay from the saved block includes the delete", about(doomed.entityKey).some((n) => /delete/i.test(n)))
check("an expiry emits no event (only its create is replayed)", !about(short.entityKey).some((n) => !/creat/i.test(n)))

const gone = await publicClient.getEntity(short.entityKey).then(() => "still there", (e: Error) => e.constructor.name)
console.log(`getEntity on the expired entity: ${gone}`)
const deleted = await publicClient.getEntity(doomed.entityKey).then(() => "still there", (e: Error) => e.constructor.name)
console.log(`getEntity on the deleted entity: ${deleted}`)
check("expired and deleted look the same to getEntity", gone === deleted)
await wallet.deleteEntity({ entityKey: liveOne.entityKey })
process.exit()
