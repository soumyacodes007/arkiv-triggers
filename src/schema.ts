// Entity formats shared by the SDK and the worker: rules, claims, receipts and heartbeats.
//
// The rule of thumb from the PRD: what workers search on goes in attributes, everything else in the
// payload. Attribute names are lowercase (the node rejects uppercase), and every number a query
// compares is a u64 (a bare number is an i32 and silently never matches a u64 range).

import {
  type CreateEntityParameters,
  ExpirationTime,
  MAX_ATTRIBUTES,
  MAX_NAME_BYTES,
  MAX_STRING_BYTES,
  i32,
  str,
  u64,
} from "@arkiv-network/sdk"
import type { Hex } from "viem"

/** Format version written as the `v` attribute on every entity, so the format can grow safely. */
export const SCHEMA_VERSION = 1

/** The `type` attribute of each entity kind. */
export const TYPES = {
  rule: "trg.rule",
  claim: "trg.claim",
  receipt: "trg.receipt",
  heartbeat: "trg.worker",
} as const

/** Arkiv's Tiramisu block time, in seconds. */
export const BLOCK_SECONDS = 2

/** How long each kind of entity lives. */
export const LIFETIMES = {
  /** A claim is a lease: if its worker crashes, it lapses and another worker takes over. */
  claimSeconds: 60,
  receiptDays: 30,
  /** A heartbeat lapses if not extended, which is how a dead worker drops off. */
  heartbeatSeconds: 300,
  heartbeatRenewSeconds: 60,
  /** A rule lives this long past its deadline, then cleans itself up. */
  ruleGraceDays: 7,
} as const

const DAY_BLOCKS = BigInt((24 * 3600) / BLOCK_SECONDS)

// ---- actions --------------------------------------------------------------------------------

export const ACTION_NAMES = ["telegram", "webhook", "receipt", "extend"] as const
export type ActionName = (typeof ACTION_NAMES)[number]

export type ActionField = { name: string; label: string; kind: "text" | "url" | "number" | "sealed" }

export type ActionDefinition = {
  name: ActionName
  label: string
  icon: string
  description: string
  fields: ActionField[]
  /** Who may fire it: any worker, or only one that holds a secret (the Telegram bot token). */
  firedBy: "any" | "telegram-worker"
}

/** The fixed action menu. The dashboard draws its forms from this; the worker runs by `name`. */
export const ACTIONS: Record<ActionName, ActionDefinition> = {
  telegram: {
    name: "telegram",
    label: "Telegram me",
    icon: "✈",
    description: "Our bot sends a message, with {entity}, {time} and {rule} filled in.",
    fields: [
      { name: "message", label: "Message", kind: "text" },
      { name: "chat", label: "Telegram chat", kind: "sealed" },
    ],
    firedBy: "telegram-worker",
  },
  webhook: {
    name: "webhook",
    label: "Call my webhook",
    icon: "🔗",
    description: "A signed POST to your URL (your server, or n8n, Make or Zapier).",
    fields: [
      { name: "url", label: "Webhook URL", kind: "url" },
      { name: "message", label: "Message", kind: "text" },
    ],
    firedBy: "any",
  },
  receipt: {
    name: "receipt",
    label: "Record a receipt",
    icon: "🧾",
    description: "Just the signed receipt on Arkiv; apps can watch for it.",
    fields: [],
    firedBy: "any",
  },
  extend: {
    name: "extend",
    label: "Extend it",
    icon: "⏳",
    description: "Extends the target entity, if it was created with permissionless extension.",
    fields: [{ name: "extendDays", label: "Extend by (days)", kind: "number" }],
    firedBy: "any",
  },
}

// ---- rules ----------------------------------------------------------------------------------

/** WHEN: the target entity expires (optionally `offset` blocks early), or a block height arrives. */
export type Trigger =
  | { on: "expire"; target: Hex; offset?: bigint }
  | { on: "block"; fireAt: bigint; offset?: bigint }

/** A rule as an app writes it. */
export type RuleInput = {
  trigger: Trigger
  action: ActionName
  /** Shown in lists and messages. */
  name?: string
  /** Message text for telegram and webhook; `{entity}`, `{time}` and `{rule}` are filled in. */
  message?: string
  /** A Telegram chat ID sealed to a worker with `sealForWorker`. Never a plain chat ID. */
  chat?: string
  /** Webhook URL. Public: never put a secret in it. */
  url?: string
  /** Days to extend the target by, for the extend action. */
  extendDays?: number
  /** "any" public worker, or one worker's address. */
  worker?: "any" | Hex
  repeat?: "once"
  /** Delivery attempts before the receipt records a failure. */
  retries?: number
  /** Lets apps find only their own rules. */
  app?: string
}

/** A rule as read back from Arkiv. */
export type Rule = Omit<RuleInput, "worker" | "repeat" | "retries"> & {
  key: Hex
  creator: Hex
  owner: Hex
  createdAt: bigint
  expiresAt: bigint
  worker: "any" | Hex
  repeat: "once"
  retries: number
  v: number
}

export class SchemaError extends Error {}

const enc = new TextEncoder()
const bytes = (s: string) => enc.encode(s).length
const HEX40 = /^0x[0-9a-fA-F]{40}$/
const HEX64 = /^0x[0-9a-fA-F]{64}$/

/** Rejects a rule that would break a safety rule or an Arkiv limit, with a reason a person can act on. */
export function validateRule(input: RuleInput): void {
  const fail = (msg: string) => {
    throw new SchemaError(msg)
  }
  const t = input.trigger
  if (t.on === "expire" && !HEX64.test(t.target)) fail("trigger.target must be an entity key (0x + 64 hex characters)")
  if (t.on === "block" && t.fireAt <= 0n) fail("trigger.fireAt must be a block height")
  if (t.offset !== undefined && t.offset < 0n) fail("trigger.offset cannot be negative")
  if (!ACTION_NAMES.includes(input.action)) fail(`action must be one of ${ACTION_NAMES.join(", ")}`)
  if (input.worker && input.worker !== "any" && !HEX40.test(input.worker)) fail("worker must be \"any\" or a worker address")
  if (input.app !== undefined && bytes(input.app) > MAX_STRING_BYTES) fail(`app must be at most ${MAX_STRING_BYTES} bytes`)

  if (input.action === "telegram") {
    if (!input.message) fail("a telegram rule needs a message")
    if (!input.chat) fail("a telegram rule needs a chat sealed with sealForWorker")
    if (input.chat && !input.chat.startsWith(SEALED_PREFIX)) fail("chat must be sealed with sealForWorker; a plain chat ID would be public")
  }
  if (input.action === "webhook") {
    if (!input.url) fail("a webhook rule needs a url")
    let u: URL | undefined
    try {
      u = new URL(input.url!)
    } catch {
      fail("url is not a valid URL")
    }
    // Plain http is allowed only for a developer's own machine; public workers refuse private
    // addresses when they fire, so such a rule only ever works on a local worker.
    const local = u && (u.hostname === "localhost" || u.hostname === "127.0.0.1")
    if (u && u.protocol !== "https:" && !(local && u.protocol === "http:")) fail("url must start with https://")
  }
  if (input.action === "extend" && !(input.extendDays && input.extendDays > 0)) fail("an extend rule needs extendDays above 0")
  if (input.retries !== undefined && (!Number.isInteger(input.retries) || input.retries < 0 || input.retries > 10)) {
    fail("retries must be a whole number from 0 to 10")
  }
}

/** Warnings a person should see before publishing, without blocking it. */
export function ruleWarnings(input: RuleInput): string[] {
  const out: string[] = []
  if (input.url && /(token|secret|key|password|sig)=|hooks\.slack\.com|discord(app)?\.com\/api\/webhooks/i.test(input.url)) {
    out.push("this URL looks like it contains a secret; rules are public, so anyone could read it")
  }
  if (input.action === "telegram" && input.worker && input.worker !== "any") {
    out.push("telegram rules can only be fired by a worker that holds the bot token and can open the sealed chat")
  }
  return out
}

/** The block a rule is due at: the target's expiry (or the fire block), minus the early offset. */
export function deadlineOf(trigger: Trigger, targetExpiresAt?: bigint): bigint {
  const base = trigger.on === "block" ? trigger.fireAt : targetExpiresAt
  if (base === undefined) throw new SchemaError("an expire rule's deadline needs the target's $expiresAt")
  const d = base - (trigger.offset ?? 0n)
  return d < 0n ? 0n : d
}

/**
 * The create parameters for a rule. `targetExpiresAt` is the target's current `$expiresAt` for an
 * expire rule; the rule then lives until that deadline plus the grace period. The worker re-reads the
 * target when it fires, so a target extended later still fires at its new deadline.
 */
export function ruleToCreate(input: RuleInput, ctx: { targetExpiresAt?: bigint } = {}): CreateEntityParameters {
  validateRule(input)
  const t = input.trigger
  const deadline = deadlineOf(t, ctx.targetExpiresAt)
  const attributes: Record<string, any> = {
    type: str(TYPES.rule),
    v: i32(SCHEMA_VERSION),
    app: str(input.app ?? "arkiv-triggers"),
    on: str(t.on),
    action: str(input.action),
    worker: str((input.worker ?? "any").toLowerCase()),
    repeat: str(input.repeat ?? "once"),
    offset: u64(t.offset ?? 0n),
  }
  if (t.on === "expire") attributes.target = str(t.target.toLowerCase())
  if (t.on === "block") attributes.fireat = u64(t.fireAt)
  checkAttributes(attributes)

  const payload = {
    name: input.name,
    message: input.message,
    chat: input.chat,
    url: input.url,
    extendDays: input.extendDays,
    retries: input.retries ?? 3,
  }
  return {
    payload: enc.encode(JSON.stringify(payload)),
    contentType: "application/json",
    attributes,
    expires: ExpirationTime.atBlock(deadline + BigInt(LIFETIMES.ruleGraceDays) * DAY_BLOCKS, {
      atLeast: ExpirationTime.fromDays(1),
    }),
  }
}

/** Reads a rule entity. Returns undefined for anything that is not a valid rule of a known version. */
export function parseRule(e: QueriedEntity): Rule | undefined {
  const a = e.attributes ?? {}
  if (val(a, "type") !== TYPES.rule || Number(val(a, "v")) !== SCHEMA_VERSION) return undefined
  const on = val(a, "on")
  const offset = big(a, "offset")
  let trigger: Trigger
  if (on === "expire" && typeof val(a, "target") === "string") trigger = { on, target: val(a, "target") as Hex, offset }
  else if (on === "block" && val(a, "fireat") !== undefined) trigger = { on, fireAt: big(a, "fireat"), offset }
  else return undefined
  const action = val(a, "action") as ActionName
  if (!ACTION_NAMES.includes(action)) return undefined
  const p = payloadJson(e)
  return {
    key: e.key!,
    creator: e.creator!,
    owner: e.owner!,
    createdAt: e.createdAt ?? 0n,
    expiresAt: e.expiresAt ?? 0n,
    v: SCHEMA_VERSION,
    trigger,
    action,
    app: val(a, "app") as string | undefined,
    worker: (val(a, "worker") as "any" | Hex | undefined) ?? "any",
    repeat: "once",
    name: p.name,
    message: p.message,
    chat: p.chat,
    url: p.url,
    extendDays: p.extendDays,
    retries: Number.isInteger(p.retries) ? p.retries : 3,
  }
}

// ---- claims ---------------------------------------------------------------------------------

export type Claim = { key: Hex; rule: Hex; worker: Hex; deadline: bigint; createdAt: bigint; expiresAt: bigint }

export function claimToCreate(rule: Hex, worker: Hex, deadline: bigint): CreateEntityParameters {
  return {
    payload: new Uint8Array(),
    contentType: "application/octet-stream",
    attributes: {
      type: str(TYPES.claim),
      v: i32(SCHEMA_VERSION),
      rule: str(rule.toLowerCase()),
      worker: str(worker.toLowerCase()),
      deadline: u64(deadline),
    },
    expires: ExpirationTime.fromSeconds(LIFETIMES.claimSeconds),
  }
}

export function parseClaim(e: QueriedEntity): Claim | undefined {
  const a = e.attributes ?? {}
  if (val(a, "type") !== TYPES.claim) return undefined
  return {
    key: e.key!,
    rule: val(a, "rule") as Hex,
    worker: val(a, "worker") as Hex,
    deadline: big(a, "deadline"),
    createdAt: e.createdAt ?? 0n,
    expiresAt: e.expiresAt ?? 0n,
  }
}

/**
 * Who handles a rule when several workers claimed it: the earliest `$createdAt`, ties broken by the
 * lowest entity key. Queries expose no transaction index, so this is what every worker can agree on
 * from the same query (see arkiv/friction.md #3).
 */
export function claimWinner<T extends { key: string; createdAt: bigint }>(claims: readonly T[]): T | undefined {
  return [...claims].sort((x, y) =>
    x.createdAt === y.createdAt ? (x.key.toLowerCase() < y.key.toLowerCase() ? -1 : 1) : x.createdAt < y.createdAt ? -1 : 1,
  )[0]
}

// ---- receipts -------------------------------------------------------------------------------

export const RECEIPT_STATUSES = ["ok", "failed", "skipped"] as const
export type ReceiptStatus = (typeof RECEIPT_STATUSES)[number]

export type ReceiptResult = {
  /** HTTP status for webhooks, Telegram's message ID for telegram, and so on. */
  code?: number
  messageId?: number
  latencyMs?: number
  attempts?: number
  error?: string
  /** For extend: the block the target now expires at. */
  newExpiresAt?: string
}

export type ReceiptInput = {
  rule: Hex
  /** The rule's creator, so apps can list receipts for their own rules. */
  ruleCreator: Hex
  action: ActionName
  status: ReceiptStatus
  /** The block the rule was due at, and the block it was fired at. */
  deadline: bigint
  firedAt: bigint
  result: ReceiptResult
  /** Why the rule fired, e.g. "target expired" or "block reached". */
  reason: string
}

export type Receipt = Omit<ReceiptInput, "ruleCreator"> & {
  key: Hex
  ruleCreator: Hex
  /** The worker that fired it: the receipt's $creator, set by Arkiv itself. */
  worker: Hex
  createdAt: bigint
}

export function receiptToCreate(r: ReceiptInput): CreateEntityParameters {
  if (!RECEIPT_STATUSES.includes(r.status)) throw new SchemaError(`status must be one of ${RECEIPT_STATUSES.join(", ")}`)
  return {
    payload: enc.encode(JSON.stringify({ result: r.result, reason: r.reason })),
    contentType: "application/json",
    attributes: {
      type: str(TYPES.receipt),
      v: i32(SCHEMA_VERSION),
      rule: str(r.rule.toLowerCase()),
      rulecreator: str(r.ruleCreator.toLowerCase()),
      action: str(r.action),
      status: str(r.status),
      deadline: u64(r.deadline),
      firedat: u64(r.firedAt),
    },
    expires: ExpirationTime.fromDays(LIFETIMES.receiptDays),
  }
}

export function parseReceipt(e: QueriedEntity): Receipt | undefined {
  const a = e.attributes ?? {}
  if (val(a, "type") !== TYPES.receipt) return undefined
  const p = payloadJson(e)
  return {
    key: e.key!,
    worker: e.creator!,
    createdAt: e.createdAt ?? 0n,
    rule: val(a, "rule") as Hex,
    ruleCreator: val(a, "rulecreator") as Hex,
    action: val(a, "action") as ActionName,
    status: val(a, "status") as ReceiptStatus,
    deadline: big(a, "deadline"),
    firedAt: big(a, "firedat"),
    result: p.result ?? {},
    reason: p.reason ?? "",
  }
}

// ---- heartbeats -----------------------------------------------------------------------------

export type HeartbeatInput = {
  version: string
  mode: "any" | "own"
  /** The last block the worker has fully processed, so a restart replays from there. */
  lastBlock: bigint
  actions: ActionName[]
  /** The owner's main wallet, and its signature over `operatorMessage(worker)`. */
  operator?: Hex
  operatorSig?: Hex
  /** The worker's public sealing key, for `sealForWorker`. */
  sealKey: Hex
}

export type Heartbeat = HeartbeatInput & { key: Hex; worker: Hex; createdAt: bigint; expiresAt: bigint }

/** The message an operator signs to link their main wallet to a worker. */
export const operatorMessage = (worker: Hex) => `I operate Arkiv Triggers worker ${worker.toLowerCase()}`

export function heartbeatToCreate(h: HeartbeatInput): CreateEntityParameters {
  return {
    payload: enc.encode(JSON.stringify({ operatorSig: h.operatorSig, sealKey: h.sealKey })),
    contentType: "application/json",
    attributes: heartbeatAttributes(h),
    expires: ExpirationTime.fromSeconds(LIFETIMES.heartbeatSeconds),
  }
}

/** The heartbeat's attributes, also used to patch it as the worker moves forward. */
export function heartbeatAttributes(h: Pick<HeartbeatInput, "version" | "mode" | "lastBlock" | "actions" | "operator">) {
  const a: Record<string, any> = {
    type: str(TYPES.heartbeat),
    v: i32(SCHEMA_VERSION),
    version: str(h.version),
    mode: str(h.mode),
    lastblock: u64(h.lastBlock),
    actions: str(h.actions.join(",")),
  }
  if (h.operator) a.operator = str(h.operator.toLowerCase())
  return a
}

export function parseHeartbeat(e: QueriedEntity): Heartbeat | undefined {
  const a = e.attributes ?? {}
  if (val(a, "type") !== TYPES.heartbeat) return undefined
  const p = payloadJson(e)
  return {
    key: e.key!,
    worker: e.creator!,
    createdAt: e.createdAt ?? 0n,
    expiresAt: e.expiresAt ?? 0n,
    version: String(val(a, "version") ?? ""),
    mode: val(a, "mode") === "own" ? "own" : "any",
    lastBlock: big(a, "lastblock"),
    actions: String(val(a, "actions") ?? "")
      .split(",")
      .filter((x): x is ActionName => (ACTION_NAMES as readonly string[]).includes(x)),
    operator: val(a, "operator") as Hex | undefined,
    operatorSig: p.operatorSig,
    sealKey: p.sealKey,
  }
}

// ---- messages -------------------------------------------------------------------------------

/** Fills {entity}, {time} and {rule} in a message. Unknown placeholders are left as they are. */
export function fillMessage(message: string, values: { entity?: string; time?: string; rule?: string }): string {
  return message.replace(/\{(entity|time|rule)\}/g, (m, k: "entity" | "time" | "rule") => values[k] ?? m)
}

/** The prefix of a chat ID sealed with `sealForWorker`. */
export const SEALED_PREFIX = "sealed:v1:"

// ---- templates ------------------------------------------------------------------------------

export type Template = { id: string; title: string; description: string; rule: Omit<RuleInput, "trigger"> & { trigger: { on: Trigger["on"]; offsetBlocks?: number } } }

/** Ready rules for the dashboard's editor; the blanks are the target, time, chat or URL. */
export const TEMPLATES: Template[] = [
  {
    id: "expiry-telegram",
    title: "When an entity expires → Telegram me",
    description: "A message the moment something you care about expires.",
    rule: { trigger: { on: "expire" }, action: "telegram", message: "⏰ {entity} has expired ({rule})" },
  },
  {
    id: "time-webhook",
    title: "At a date and time → call my webhook",
    description: "A signed POST to your server or automation tool at the time you pick.",
    rule: { trigger: { on: "block" }, action: "webhook", message: "{rule} fired at {time}" },
  },
  {
    id: "keep-alive",
    title: "1 day before expiry → extend it 30 days",
    description: "Keeps an entity alive, if it allows permissionless extension.",
    rule: { trigger: { on: "expire", offsetBlocks: Number(DAY_BLOCKS) }, action: "extend", extendDays: 30 },
  },
]

// ---- helpers --------------------------------------------------------------------------------

/** The fields of a query result the parsers use. */
export type QueriedEntity = {
  key?: Hex
  creator?: Hex
  owner?: Hex
  createdAt?: bigint
  expiresAt?: bigint
  payload?: Uint8Array
  attributes?: Record<string, { type?: string; value?: unknown } | undefined>
}

function val(a: NonNullable<QueriedEntity["attributes"]>, name: string): unknown {
  return a[name]?.value
}

function big(a: NonNullable<QueriedEntity["attributes"]>, name: string): bigint {
  const v = val(a, name)
  return typeof v === "bigint" ? v : v === undefined ? 0n : BigInt(v as number | string)
}

function payloadJson(e: QueriedEntity): any {
  try {
    return e.payload?.length ? JSON.parse(new TextDecoder().decode(e.payload)) : {}
  } catch {
    return {}
  }
}

/** Arkiv's limits, checked before a transaction is spent on a write the node would reject. */
export function checkAttributes(attributes: Record<string, unknown>): void {
  const names = Object.keys(attributes)
  if (names.length > MAX_ATTRIBUTES) throw new SchemaError(`at most ${MAX_ATTRIBUTES} attributes`)
  for (const n of names) {
    if (!/^[a-z][a-z0-9._-]*$/.test(n)) throw new SchemaError(`attribute name "${n}" must be lowercase letters, digits, ".", "_" or "-", starting with a letter`)
    if (bytes(n) > MAX_NAME_BYTES) throw new SchemaError(`attribute name "${n}" is over ${MAX_NAME_BYTES} bytes`)
    const v = (attributes[n] as any)?.value
    if (typeof v === "string" && bytes(v) > MAX_STRING_BYTES) throw new SchemaError(`attribute "${n}" is over ${MAX_STRING_BYTES} bytes`)
  }
}
