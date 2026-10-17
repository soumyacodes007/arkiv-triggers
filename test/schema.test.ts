import assert from "node:assert/strict"
import { test } from "node:test"
import { str, u64 } from "@arkiv-network/sdk"
import { and, eq, lte, render } from "@arkiv-network/sdk/query"
import type { Hex } from "viem"
import {
  ACTIONS,
  ACTION_NAMES,
  SEALED_PREFIX,
  SchemaError,
  TEMPLATES,
  TYPES,
  checkAttributes,
  claimToCreate,
  claimWinner,
  deadlineOf,
  fillMessage,
  heartbeatToCreate,
  parseClaim,
  parseHeartbeat,
  parseReceipt,
  parseRule,
  receiptToCreate,
  ruleToCreate,
  ruleWarnings,
} from "../src/schema"

const TARGET = `0x${"ab".repeat(32)}` as Hex
const CREATOR = `0x${"c1".repeat(20)}` as Hex
const WORKER = `0x${"f7".repeat(20)}` as Hex

/** What a query would return for an entity written with these create parameters. */
function asQueried(p: { attributes?: any; payload: Uint8Array }, extra: Partial<{ key: Hex; creator: Hex; createdAt: bigint; expiresAt: bigint }> = {}) {
  return {
    key: extra.key ?? (`0x${"11".repeat(32)}` as Hex),
    creator: extra.creator ?? CREATOR,
    owner: extra.creator ?? CREATOR,
    createdAt: extra.createdAt ?? 100n,
    expiresAt: extra.expiresAt ?? 9_999n,
    payload: p.payload,
    attributes: p.attributes,
  }
}

test("an expire rule round-trips through its entity form", () => {
  const p = ruleToCreate(
    { trigger: { on: "expire", target: TARGET, offset: 1800n }, action: "webhook", url: "https://example.com/hook", name: "Lease reminder" },
    { targetExpiresAt: 50_000n },
  )
  const r = parseRule(asQueried(p))!
  assert.equal(r.trigger.on, "expire")
  assert.equal((r.trigger as any).target, TARGET.toLowerCase())
  assert.equal(r.trigger.offset, 1800n)
  assert.equal(r.action, "webhook")
  assert.equal(r.url, "https://example.com/hook")
  assert.equal(r.name, "Lease reminder")
  assert.equal(r.worker, "any")
  assert.equal(r.retries, 3)
})

test("a block rule stores fireat as u64, so range queries match it", () => {
  const p = ruleToCreate({ trigger: { on: "block", fireAt: 1_250_000n }, action: "receipt" })
  const attrs = p.attributes as Record<string, { type: string; value: unknown }>
  assert.equal(attrs.fireat.type, "u64")
  assert.equal(attrs.offset.type, "u64")
  assert.equal(parseRule(asQueried(p))!.trigger.on, "block")
  // The worker's "due now" query must use u64, never a bare number (arkiv/friction.md #1).
  const q = render(and(eq("type", str(TYPES.rule)), eq("on", str("block")), lte("fireat", u64(1_250_100n))))
  assert.match(q, /fireat <= u64\(1250100\)/)
})

test("every attribute name is lowercase and within Arkiv's limits", () => {
  const all = [
    ruleToCreate({ trigger: { on: "block", fireAt: 10n }, action: "receipt" }),
    claimToCreate(TARGET, WORKER, 10n),
    receiptToCreate({ rule: TARGET, ruleCreator: CREATOR, action: "receipt", status: "ok", deadline: 1n, firedAt: 2n, result: {}, reason: "block reached" }),
    heartbeatToCreate({ version: "0.1.0", mode: "any", lastBlock: 5n, actions: ["receipt"], sealKey: "0x00" }),
  ]
  for (const p of all) {
    checkAttributes(p.attributes as any)
    for (const name of Object.keys(p.attributes!)) assert.match(name, /^[a-z][a-z0-9._-]*$/)
  }
  assert.throws(() => checkAttributes({ fireAt: u64(1n) }), SchemaError)
  // The SDK's own str() refuses an over-long value before we see it; our check covers raw values too.
  assert.throws(() => str("x".repeat(129)), /128-byte limit/)
  assert.throws(() => checkAttributes({ note: { type: "str", value: "x".repeat(129) } }), SchemaError)
})

test("unsafe or incomplete rules are refused with a reason", () => {
  const bad = (input: any, re: RegExp) => assert.throws(() => ruleToCreate(input, { targetExpiresAt: 100n }), re)
  bad({ trigger: { on: "expire", target: "0x12" }, action: "receipt" }, /entity key/)
  bad({ trigger: { on: "block", fireAt: 10n }, action: "run-code" }, /action must be one of/)
  bad({ trigger: { on: "block", fireAt: 10n }, action: "webhook", url: "http://insecure.example" }, /https/)
  bad({ trigger: { on: "block", fireAt: 10n }, action: "telegram", message: "hi", chat: "123456789" }, /sealed/)
  bad({ trigger: { on: "block", fireAt: 10n }, action: "extend" }, /extendDays/)
  bad({ trigger: { on: "block", fireAt: 10n }, action: "receipt", worker: "0xnotanaddress" }, /worker/)
  // A sealed chat is accepted.
  ruleToCreate({ trigger: { on: "block", fireAt: 10n }, action: "telegram", message: "hi", chat: `${SEALED_PREFIX}abc` })
})

test("secret-looking webhook URLs are flagged", () => {
  const w = ruleWarnings({ trigger: { on: "block", fireAt: 10n }, action: "webhook", url: "https://hooks.slack.com/services/T0/B0/xyz" })
  assert.equal(w.length, 1)
  assert.equal(ruleWarnings({ trigger: { on: "block", fireAt: 10n }, action: "webhook", url: "https://myapp.com/hook" }).length, 0)
})

test("the deadline subtracts the early offset and never goes below zero", () => {
  assert.equal(deadlineOf({ on: "expire", target: TARGET, offset: 1800n }, 10_000n), 8_200n)
  assert.equal(deadlineOf({ on: "block", fireAt: 100n, offset: 500n }), 0n)
  assert.throws(() => deadlineOf({ on: "expire", target: TARGET }), SchemaError)
})

test("claims, receipts and heartbeats round-trip", () => {
  const c = parseClaim(asQueried(claimToCreate(TARGET, WORKER, 777n), { createdAt: 5n }))!
  assert.deepEqual([c.rule, c.worker, c.deadline], [TARGET.toLowerCase(), WORKER.toLowerCase(), 777n])

  const r = parseReceipt(
    asQueried(
      receiptToCreate({
        rule: TARGET,
        ruleCreator: CREATOR,
        action: "webhook",
        status: "ok",
        deadline: 10n,
        firedAt: 11n,
        result: { code: 200, latencyMs: 182, attempts: 1 },
        reason: "target expired",
      }),
      { creator: WORKER },
    ),
  )!
  assert.equal(r.worker, WORKER) // the worker is the receipt's $creator, not a field anyone can write
  assert.equal(r.status, "ok")
  assert.equal(r.result.code, 200)
  assert.equal(r.firedAt, 11n)

  const h = parseHeartbeat(
    asQueried(heartbeatToCreate({ version: "0.1.0", mode: "own", lastBlock: 42n, actions: ["webhook", "receipt"], operator: CREATOR, operatorSig: "0xsig", sealKey: "0xkey" }), {
      creator: WORKER,
    }),
  )!
  assert.deepEqual([h.worker, h.mode, h.lastBlock, h.actions, h.operator, h.operatorSig, h.sealKey], [WORKER, "own", 42n, ["webhook", "receipt"], CREATOR.toLowerCase(), "0xsig", "0xkey"])
})

test("entities of another type or version are ignored", () => {
  const p = ruleToCreate({ trigger: { on: "block", fireAt: 10n }, action: "receipt" })
  const attrs = { ...(p.attributes as any), v: { type: "i32", value: 99 } }
  assert.equal(parseRule(asQueried({ ...p, attributes: attrs })), undefined)
  assert.equal(parseRule(asQueried(claimToCreate(TARGET, WORKER, 1n))), undefined)
})

test("the claim winner is the earliest block, then the lowest key", () => {
  const w = claimWinner([
    { key: "0xbb", createdAt: 10n },
    { key: "0xaa", createdAt: 10n },
    { key: "0x00", createdAt: 11n },
  ])
  assert.equal(w?.key, "0xaa")
  assert.equal(claimWinner([]), undefined)
})

test("messages fill known placeholders only", () => {
  assert.equal(fillMessage("⏰ {entity} at {time} ({rule}) {other}", { entity: "0xab", time: "4 PM", rule: "Lease" }), "⏰ 0xab at 4 PM (Lease) {other}")
})

test("the action menu and templates are consistent", () => {
  for (const name of ACTION_NAMES) assert.equal(ACTIONS[name].name, name)
  for (const t of TEMPLATES) assert.ok(ACTION_NAMES.includes(t.rule.action))
})
