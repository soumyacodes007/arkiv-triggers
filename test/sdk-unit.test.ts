import assert from "node:assert/strict"
import { test } from "node:test"
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts"
import { SEALED_PREFIX, operatorMessage } from "../src/schema"
import { SealError, openSealed, sealForWorker, workerSealKeys } from "../src/seal"
import { operatorVerified } from "../src/sdk"
import { toBlock, toDate } from "../src/time"
import { verifyWebhook } from "../src/webhook"

test("a sealed chat ID opens only for the worker it was sealed to", () => {
  const worker = generatePrivateKey()
  const other = generatePrivateKey()
  const { publicKey } = workerSealKeys(worker)
  const sealed = sealForWorker("123456789", publicKey)
  assert.ok(sealed.startsWith(SEALED_PREFIX))
  assert.ok(!sealed.includes("123456789"), "the plain chat ID never appears")
  assert.equal(openSealed(sealed, worker), "123456789")
  assert.throws(() => openSealed(sealed, other), SealError)
  assert.notEqual(sealForWorker("123456789", publicKey), sealed, "each seal uses a fresh ephemeral key")
})

test("a tampered seal is refused", () => {
  const worker = generatePrivateKey()
  const sealed = sealForWorker("chat", workerSealKeys(worker).publicKey)
  const flipped = sealed.slice(0, -2) + (sealed.endsWith("A") ? "B" : "A") + sealed.slice(-1)
  assert.throws(() => openSealed(flipped, worker), SealError)
})

test("sealing keys are stable for a worker key", () => {
  const worker = generatePrivateKey()
  assert.equal(workerSealKeys(worker).publicKey, workerSealKeys(worker).publicKey)
})

test("webhooks verify only when signed by a trusted worker", async () => {
  const worker = privateKeyToAccount(generatePrivateKey())
  const stranger = privateKeyToAccount(generatePrivateKey())
  const body = JSON.stringify({ event: "e1", rule: "0x01" })
  const sig = await worker.signMessage({ message: body })
  assert.deepEqual(await verifyWebhook(body, sig, [worker.address]), { ok: true, worker: worker.address })
  assert.equal((await verifyWebhook(body, sig, [stranger.address])).ok, false)
  assert.equal((await verifyWebhook(body + " ", sig, [worker.address])).ok, false, "a changed body fails")
  assert.equal((await verifyWebhook(body, undefined, [worker.address])).ok, false)
  assert.equal((await verifyWebhook(body, "0x1234", [worker.address])).ok, false)
})

test("an operator signature links a wallet to a worker and cannot be faked", async () => {
  const operator = privateKeyToAccount(generatePrivateKey())
  const worker = privateKeyToAccount(generatePrivateKey()).address
  const sig = await operator.signMessage({ message: operatorMessage(worker) })
  assert.equal(await operatorVerified({ worker, operator: operator.address, operatorSig: sig }), true)
  const otherWorker = privateKeyToAccount(generatePrivateKey()).address
  assert.equal(await operatorVerified({ worker: otherWorker, operator: operator.address, operatorSig: sig }), false)
})

test("dates and blocks convert both ways at 2 s per block", () => {
  const clock = { block: 1_000_000n, timeMs: Date.UTC(2026, 9, 17, 12, 0, 0) }
  const inOneHour = clock.timeMs + 3_600_000
  assert.equal(toBlock(inOneHour, clock), 1_001_800n)
  assert.equal(toDate(1_001_800n, clock).getTime(), inOneHour)
  assert.equal(toBlock(clock.timeMs + 1, clock), 1_000_001n, "rounds up so a deadline is never early")
})

test("a query that never answers fails with a clear error instead of hanging", async () => {
  const { pageAll, QueryTimeoutError } = await import("../src/query")
  const never = { getBlockNumber: async () => 1n }
  const build = () => ({ limit: () => ({ atBlock: () => ({ [Symbol.asyncIterator]: () => ({ next: () => new Promise(() => {}) }) }) }) })
  const started = Date.now()
  await assert.rejects(pageAll(never, build, (e) => e, { timeoutMs: 200 }), (e: unknown) => e instanceof QueryTimeoutError && /access key/.test((e as Error).message))
  assert.ok(Date.now() - started < 2_000)
})

test("a dropped event feed reconnects once per outage, however many errors it reports", async () => {
  const { followEvents } = await import("../src/feed")
  // Like viem on a dead socket: every subscription reports several errors, and each new one fails too.
  let connects = 0
  let closed = 0
  const client = () => ({
    transport: { getRpcClient: async () => ({ close: () => closed++ }) },
    watchEntityEvents: (p: any) => {
      connects++
      setTimeout(() => [1, 2, 3].forEach(() => p.onError(new Error("socket closed"))), 5)
      return () => {}
    },
  })
  let downs = 0
  const stop = followEvents("wss://x", { onEvent: () => {} }, { onDown: () => downs++ }, { client, backoffMs: [10] })
  await new Promise((r) => setTimeout(r, 200))
  stop()
  const after = connects
  await new Promise((r) => setTimeout(r, 50))
  assert.ok(connects >= 3 && connects <= 15, `linear reconnects, got ${connects}`) // the old code reached hundreds
  assert.equal(downs, connects, "one onDown per connection, not one per error")
  assert.ok(closed >= connects - 1, "each failed socket is closed")
  assert.equal(connects, after, "no reconnect after stop")
})

test("rate-limit errors are logged as one line that says what to do", async () => {
  const { describeError } = await import("../src/query")
  const http = (details: string) => Object.assign(new Error("HTTP request failed.\n\nStatus: 429\nURL: …\nRequest body: {…}"), { shortMessage: "HTTP request failed.", status: 429, details })
  assert.match(describeError(http('"QUOTA_EXCEEDED"')), /quota for this access key is used up/)
  assert.match(describeError(http('{"error":"ANON_COST_LIMITED"}')), /ARKIV_ACCESS_KEY/)
  assert.equal(describeError(Object.assign(new Error("x\ny"), { status: 500, details: "boom" })), "x · status 500 · boom")
  assert.equal(describeError(new Error("The socket has been closed.")), "The socket has been closed.")
})

test("Arkiv RPC: gateway errors are retried, a 429 is returned at once (never waited out)", async (t) => {
  const { createServer } = await import("node:http")
  const { patientFetch } = await import("../src/query")
  let hits = 0
  const statuses = [504, 502, 200]
  const srv = createServer((req, res) => {
    const path = req.url
    hits++
    if (path === "/limited") {
      res.writeHead(429, { "retry-after": "3217" })
      return res.end("{}")
    }
    res.writeHead(statuses[Math.min(hits - 1, 2)])
    res.end("{}")
  })
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r))
  const port = (srv.address() as { port: number }).port
  t.after(() => srv.close())
  const ok = await patientFetch(`http://127.0.0.1:${port}/`)
  assert.equal(ok.status, 200, "two gateway errors, then success")
  assert.equal(hits, 3)
  hits = 0
  const started = Date.now()
  const limited = await patientFetch(`http://127.0.0.1:${port}/limited`)
  assert.equal(limited.status, 429)
  assert.equal(hits, 1, "a 429 is not retried")
  assert.ok(Date.now() - started < 2_000, "and nothing waits for Retry-After")
  srv.close()
})

test("the viem transport does not retry an Arkiv quota refusal", async (t) => {
  const { createServer } = await import("node:http")
  const { createPublicClient, http } = await import("viem")
  const { rpcOptions } = await import("../src/query")
  let hits = 0
  const server = createServer((_req, res) => {
    hits++
    res.writeHead(429, { "content-type": "application/json", "retry-after": "1" })
    res.end(JSON.stringify({ error: "QUOTA_EXCEEDED" }))
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  t.after(() => server.close())
  const port = (server.address() as { port: number }).port
  const client = createPublicClient({ transport: http(`http://127.0.0.1:${port}`, rpcOptions()) })
  await assert.rejects(client.getBlockNumber({ cacheTime: 0 }), /QUOTA_EXCEEDED/)
  assert.equal(hits, 1, "Retry-After must not trigger an additional request")
})
