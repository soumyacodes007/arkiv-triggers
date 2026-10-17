import assert from "node:assert/strict"
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { test } from "node:test"
import type { Hex } from "viem"
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts"
import { RUNNERS, assertPublicUrl } from "../src/actions/index"
import type { ActionContext } from "../src/actions/types"
import type { Rule } from "../src/schema"
import { WEBHOOK_HEADERS, verifyWebhook } from "../src/webhook"

const key = generatePrivateKey()
const account = privateKeyToAccount(key)

function ctx(rule: Partial<Rule>, extra: Partial<ActionContext> = {}): ActionContext {
  return {
    rule: {
      key: `0x${"aa".repeat(32)}` as Hex,
      creator: `0x${"c1".repeat(20)}` as Hex,
      owner: `0x${"c1".repeat(20)}` as Hex,
      createdAt: 1n,
      expiresAt: 999n,
      v: 1,
      trigger: { on: "block", fireAt: 100n },
      action: "webhook",
      worker: "any",
      repeat: "once",
      retries: 2,
      ...rule,
    } as Rule,
    deadline: 100n,
    firedAt: 101n,
    timeText: "2026-10-17 16:00 UTC",
    eventId: `0x${"ee".repeat(32)}` as Hex,
    account,
    workerKey: key,
    wallet: undefined,
    fetch,
    ...extra,
  }
}

async function server(statuses: number[]) {
  const hits: { body: string; sig: string; event: string }[] = []
  const s = createServer((req, res) => {
    let body = ""
    req.on("data", (c) => (body += c))
    req.on("end", () => {
      hits.push({ body, sig: String(req.headers[WEBHOOK_HEADERS.signature]), event: String(req.headers[WEBHOOK_HEADERS.event]) })
      res.statusCode = statuses[Math.min(hits.length - 1, statuses.length - 1)]
      res.end("ok")
    })
  })
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r))
  return { url: `http://127.0.0.1:${(s.address() as AddressInfo).port}/hook`, hits, close: () => s.close() }
}

test("a webhook is signed by the worker and carries the filled message", async () => {
  const srv = await server([200])
  const out = await RUNNERS.webhook(ctx({ url: srv.url, message: "{rule} at {time}", name: "Lease" }, { allowLocal: true }))
  srv.close()
  assert.equal(out.ok, true)
  assert.equal(out.result.code, 200)
  assert.equal(srv.hits.length, 1)
  const v = await verifyWebhook(srv.hits[0].body, srv.hits[0].sig, [account.address])
  assert.equal(v.ok, true)
  assert.equal(JSON.parse(srv.hits[0].body).message, "Lease at 2026-10-17 16:00 UTC")
})

test("a failing webhook is retried with the same event ID, then reported", { timeout: 30_000 }, async () => {
  const srv = await server([500, 503, 200])
  const out = await RUNNERS.webhook(ctx({ url: srv.url, retries: 2 }, { allowLocal: true }))
  srv.close()
  assert.equal(out.ok, true)
  assert.equal(out.result.attempts, 3)
  assert.equal(new Set(srv.hits.map((h) => h.event)).size, 1, "every retry carries the same x-trg-event")
})

test("a 4xx is not retried", async () => {
  const srv = await server([404])
  const out = await RUNNERS.webhook(ctx({ url: srv.url, retries: 3 }, { allowLocal: true }))
  srv.close()
  assert.equal(out.ok, false)
  assert.equal(srv.hits.length, 1)
  assert.equal(out.result.attempts, 1, "reports the attempts actually made")
})

test("public workers refuse private and loopback webhook targets", async () => {
  for (const url of ["http://127.0.0.1:8080/x", "https://10.0.0.5/x", "https://169.254.169.254/latest", "https://[::1]/x", "https://192.168.1.1/x"]) {
    await assert.rejects(assertPublicUrl(url), /private/, url)
  }
  const srv = await server([200])
  const out = await RUNNERS.webhook(ctx({ url: srv.url })) // allowLocal not set
  srv.close()
  assert.equal(out.ok, false)
  assert.equal(srv.hits.length, 0, "the request was never sent")
})

test("telegram without a token, and extend without days, fail with a reason", async () => {
  const t = await RUNNERS.telegram(ctx({ action: "telegram", chat: "sealed:v1:x", message: "hi" }))
  assert.match(t.result.error ?? "", /no Telegram bot token/)
  const x = await RUNNERS.extend(ctx({ action: "extend", trigger: { on: "expire", target: `0x${"ab".repeat(32)}` as Hex } }))
  assert.match(x.result.error ?? "", /extendDays/)
})
