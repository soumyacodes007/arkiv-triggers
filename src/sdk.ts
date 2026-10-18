// createTriggers: the SDK apps and the dashboard use to write rules and read what workers did.
// It needs only an Arkiv wallet (for writes) or nothing at all (for reads): never a server URL,
// because everything lives on Arkiv.

import { createPublicClient, str, u64 } from "@arkiv-network/sdk"
import { tiramisu } from "@arkiv-network/sdk/chains"
import { and, eq, gte } from "@arkiv-network/sdk/query"
import { type Hex, http, verifyMessage } from "viem"
import {
  type Claim,
  type Heartbeat,
  type Receipt,
  type Rule,
  type RuleInput,
  TYPES,
  deadlineOf,
  operatorMessage,
  parseClaim,
  parseHeartbeat,
  parseReceipt,
  parseRule,
  ruleToCreate,
  ruleWarnings,
} from "./schema"
import { followEvents } from "./feed"
import { describeError, pageAll, rpcOptions } from "./query"
import { type BlockClock, toBlock as blockAt, toDate as dateAt } from "./time"

export const DEFAULT_RPC_URL = "https://rpc.tiramisu.db-chain.testnet.arkiv.network"
export const DEFAULT_WS_URL = "wss://rpc.tiramisu.db-chain.testnet.arkiv.network"

export class TriggersError extends Error {}

/** The wallet methods the SDK writes with (an Arkiv SDK wallet client). */
type Writer = {
  account?: { address: Hex } | undefined
  createEntity: (p: any) => Promise<{ entityKey: Hex; txHash: Hex }>
  executeBatch: (p: any) => Promise<{ txHash: Hex; createdEntities: Hex[] }>
  deleteEntity: (p: { entityKey: Hex }) => Promise<{ txHash: Hex }>
}

export type TriggersOptions = {
  /** An Arkiv SDK wallet client. Needed only to create or delete rules. */
  wallet?: Writer
  /** An Arkiv SDK public client; one is created from `rpcUrl` if omitted. */
  publicClient?: any
  rpcUrl?: string
  wsUrl?: string
  /** An Arkiv access key for higher rate limits. Server side only: it is a secret. */
  accessKey?: string
  /** Written as the rule's `app` attribute, so an app can find only its own rules. */
  app?: string
}

export type RuleStatus = "active" | "fired" | "failed"
export type RuleWithStatus = Rule & { status: RuleStatus; deadline?: bigint; receipts: Receipt[] }
export type AuditTrail = {
  rule: Rule
  status: RuleStatus
  deadline?: bigint
  /** The target's current expiry, or undefined once it has expired or been deleted. */
  targetExpiresAt?: bigint
  /** Live claims only: a claim is a 60-second lease and drops out of queries when it lapses. */
  claims: Claim[]
  receipts: Receipt[]
}
export type WorkerInfo = Heartbeat & { online: boolean; operatorVerified: boolean }

export type WatchHandlers = {
  /** Only receipts for rules created by this wallet, or for this one rule. */
  creator?: Hex
  rule?: Hex
  onReceipt?: (r: Receipt) => void
  /** New rules created by `creator`. */
  onRule?: (r: Rule) => void
  /** A worker's heartbeat appeared or was renewed. */
  onHeartbeat?: (w: WorkerInfo) => void
  /** "live" while the WebSocket is connected, "reconnecting" while it is being restored. */
  onStatus?: (s: "live" | "reconnecting") => void
  onError?: (e: Error) => void
  /** The least time between two refreshes, however busy the chain is. Default 1000 ms; a browser on
   * the anonymous quota should use more. */
  minIntervalMs?: number
}

export function createTriggers(opts: TriggersOptions = {}) {
  const rpcUrl = opts.rpcUrl ?? DEFAULT_RPC_URL
  const wsUrl = opts.wsUrl ?? DEFAULT_WS_URL
  const headers = opts.accessKey ? { "X-API-KEY": opts.accessKey } : undefined
  const reader: any = opts.publicClient ?? createPublicClient({ chain: tiramisu, transport: http(rpcUrl, rpcOptions(headers)) })

  function wallet(): Writer {
    if (!opts.wallet) throw new TriggersError("pass a wallet to createTriggers({ wallet }) to create or delete rules")
    return opts.wallet
  }

  /** Pages through a query pinned to one block, failing after 30 s rather than hanging (friction #10). */
  const all = <T>(build: (c: any) => any, map: (e: any) => T | undefined) => pageAll(reader, build, map)
  const FULL = { key: true, creator: true, owner: true, createdAt: true, expiresAt: true, attributes: true, payload: true } as const

  async function targetExpiresAt(target: Hex): Promise<bigint | undefined> {
    try {
      const e = await reader.getEntity(target)
      return e.expiresAt as bigint
    } catch (e) {
      // Only "no such entity" means gone. A refused or failed read (an exhausted quota, a timeout) is
      // reported as itself, not as a missing target.
      if ((e as Error)?.name === "NoEntityFoundError") return undefined
      throw new TriggersError(`could not read target ${target}: ${describeError(e)}`)
    }
  }

  async function prepare(input: RuleInput) {
    const withApp = { app: opts.app, ...input }
    if (input.trigger.on !== "expire") return ruleToCreate(withApp)
    // A target created a moment ago can be missing from reads for a second or two (friction #5).
    let exp = await targetExpiresAt(input.trigger.target)
    for (let i = 0; i < 8 && exp === undefined; i++) {
      await new Promise((r) => setTimeout(r, 1_250))
      exp = await targetExpiresAt(input.trigger.target)
    }
    if (exp === undefined) throw new TriggersError(`target ${input.trigger.target} was not found: it has expired, been deleted, or never existed`)
    return ruleToCreate(withApp, { targetExpiresAt: exp })
  }

  async function createRule(input: RuleInput): Promise<{ key: Hex; txHash: Hex; warnings: string[] }> {
    const res = await wallet().createEntity(await prepare(input))
    return { key: res.entityKey, txHash: res.txHash, warnings: ruleWarnings(input) }
  }

  /** Several rules in one transaction: they all land or none does. */
  async function createRules(inputs: RuleInput[]): Promise<{ keys: Hex[]; txHash: Hex; warnings: string[] }> {
    const creates = await Promise.all(inputs.map(prepare))
    const res = await wallet().executeBatch({ creates })
    return { keys: res.createdEntities, txHash: res.txHash, warnings: inputs.flatMap(ruleWarnings) }
  }

  async function deleteRule(key: Hex): Promise<{ txHash: Hex }> {
    return wallet().deleteEntity({ entityKey: key })
  }

  async function listReceipts(filter: { rule?: Hex; creator?: Hex; sinceBlock?: bigint } = {}): Promise<Receipt[]> {
    const where = [eq("type", str(TYPES.receipt))]
    if (filter.rule) where.push(eq("rule", str(filter.rule.toLowerCase())))
    if (filter.creator) where.push(eq("rulecreator", str(filter.creator.toLowerCase())))
    if (filter.sinceBlock !== undefined) where.push(gte("firedat", u64(filter.sinceBlock)))
    const rows = await all((c) => c.select(FULL).where(and(where)), parseReceipt)
    return rows.sort((a, b) => (a.firedAt === b.firedAt ? Number(b.createdAt - a.createdAt) : b.firedAt > a.firedAt ? 1 : -1))
  }

  function statusOf(receipts: Receipt[]): RuleStatus {
    if (receipts.some((r) => r.status === "ok" || r.status === "skipped")) return "fired"
    if (receipts.length) return "failed"
    return "active"
  }

  async function deadlineFor(rule: Rule): Promise<{ deadline?: bigint; targetExpiresAt?: bigint }> {
    if (rule.trigger.on === "block") return { deadline: deadlineOf(rule.trigger) }
    const exp = await targetExpiresAt(rule.trigger.target)
    return exp === undefined ? {} : { deadline: deadlineOf(rule.trigger, exp), targetExpiresAt: exp }
  }

  /** Every rule a wallet created, with its status (from receipts) and its current deadline. */
  async function listRules(filter: { creator: Hex; app?: string }): Promise<RuleWithStatus[]> {
    const where = [eq("type", str(TYPES.rule))]
    if (filter.app) where.push(eq("app", str(filter.app)))
    const [rules, receipts] = await Promise.all([
      all((c) => c.select(FULL).where(and(where)).createdBy(filter.creator), parseRule),
      listReceipts({ creator: filter.creator }),
    ])
    // A rule with a receipt is finished: its receipt records the deadline, so its target need not be
    // read again. Rules that share a target read it once. (Each read is a query against the quota.)
    const lookups = new Map<string, Promise<{ deadline?: bigint; targetExpiresAt?: bigint }>>()
    const out = await Promise.all(
      rules.map(async (rule) => {
        const mine = receipts.filter((r) => r.rule.toLowerCase() === rule.key.toLowerCase())
        const status = statusOf(mine)
        if (status === "fired") return { ...rule, deadline: mine[0].deadline, status, receipts: mine }
        const k = rule.trigger.on === "expire" ? `${rule.trigger.target.toLowerCase()}:${rule.trigger.offset ?? 0n}` : rule.key
        if (!lookups.has(k)) lookups.set(k, deadlineFor(rule))
        return { ...rule, ...(await lookups.get(k)!), status, receipts: mine }
      }),
    )
    return out.sort((a, b) => (a.deadline ?? 0n) < (b.deadline ?? 0n) ? -1 : 1)
  }

  /** One rule with everything that happened to it: live claims, receipts and the target's state. */
  async function getRule(key: Hex): Promise<AuditTrail | undefined> {
    let entity: any
    try {
      entity = await reader.getEntity(key)
    } catch {
      return undefined
    }
    const rule = parseRule(entity)
    if (!rule) return undefined
    const [claims, receipts, when] = await Promise.all([
      all((c) => c.select(FULL).where(and(eq("type", str(TYPES.claim)), eq("rule", str(key.toLowerCase())))), parseClaim),
      listReceipts({ rule: key }),
      deadlineFor(rule),
    ])
    return { rule, status: statusOf(receipts), ...when, claims, receipts }
  }

  /** Workers from their heartbeats. An expired heartbeat drops out of queries, so these are the live ones. */
  async function listWorkers(filter: { operator?: Hex } = {}): Promise<WorkerInfo[]> {
    const where = [eq("type", str(TYPES.heartbeat))]
    if (filter.operator) where.push(eq("operator", str(filter.operator.toLowerCase())))
    const head: bigint = await reader.getBlockNumber()
    const beats = await all((c) => c.select(FULL).where(and(where)), parseHeartbeat)
    return Promise.all(beats.map(async (h) => ({ ...h, online: h.expiresAt > head, operatorVerified: await operatorVerified(h) })))
  }

  /**
   * Live updates over one WebSocket. Arkiv's event feed is unfiltered and carries no attributes, so
   * each burst of events triggers a few cheap filtered queries ("receipts fired since the last one I
   * saw") instead of fetching every new entity on the chain.
   */
  function watch(h: WatchHandlers): () => void {
    let stopped = false
    let receiptFloor = 0n
    const seenReceipts = new Set<string>()
    const seenRules = new Set<string>()
    const seenBeats = new Map<string, bigint>()
    let primed = false

    async function refresh(emit: boolean) {
      if (h.onReceipt) {
        const rs = await listReceipts({ rule: h.rule, creator: h.creator, sinceBlock: receiptFloor })
        for (const r of [...rs].reverse()) {
          if (seenReceipts.has(r.key)) continue
          seenReceipts.add(r.key)
          if (r.firedAt > receiptFloor) receiptFloor = r.firedAt
          if (emit) h.onReceipt(r)
        }
      }
      if (h.onRule && h.creator) {
        const rules = await all((c) => c.select(FULL).where(eq("type", str(TYPES.rule))).createdBy(h.creator), parseRule)
        for (const r of rules) {
          if (seenRules.has(r.key)) continue
          seenRules.add(r.key)
          if (emit) h.onRule(r)
        }
      }
      if (h.onHeartbeat) {
        for (const w of await listWorkers()) {
          if (seenBeats.get(w.key) === w.expiresAt) continue
          seenBeats.set(w.key, w.expiresAt)
          if (emit) h.onHeartbeat(w)
        }
      }
    }

    // At most one refresh per minIntervalMs (1 s by default), however busy the chain is.
    let pending = false
    let running = false
    async function schedule() {
      if (running) {
        pending = true
        return
      }
      running = true
      try {
        await refresh(primed)
        primed = true
      } catch (e) {
        h.onError?.(e as Error)
      } finally {
        await new Promise((r) => setTimeout(r, h.minIntervalMs ?? 1_000))
        running = false
        if (pending && !stopped) {
          pending = false
          void schedule()
        }
      }
    }

    const stopEvents = followEvents(
      wsUrl,
      { onEvent: () => void schedule() },
      {
        onUp: () => {
          h.onStatus?.("live")
          // Re-run the snapshot on every (re)connect: it fills in whatever happened while disconnected.
          void schedule()
        },
        onDown: (e) => {
          h.onError?.(e)
          h.onStatus?.("reconnecting")
        },
      },
    )
    return () => {
      stopped = true
      stopEvents()
    }
  }

  async function clock(): Promise<BlockClock> {
    const t = await reader.getBlockTiming()
    return { block: t.currentBlock, timeMs: Number(t.currentBlockTime) * 1000, blockSeconds: Number(t.blockDuration) || undefined }
  }

  return {
    reader,
    createRule,
    createRules,
    deleteRule,
    listRules,
    getRule,
    listReceipts,
    listWorkers,
    watch,
    clock,
    /** The block expected at `date`, from the chain's current block and time. */
    toBlock: async (date: Date | number) => blockAt(date, await clock()),
    /** The time `block` is expected at. */
    toDate: async (block: bigint) => dateAt(block, await clock()),
  }
}

export type Triggers = ReturnType<typeof createTriggers>

/** True when the heartbeat's operator really signed "I operate worker <this worker>". */
export async function operatorVerified(h: Pick<Heartbeat, "worker" | "operator" | "operatorSig">): Promise<boolean> {
  if (!h.operator || !h.operatorSig) return false
  try {
    return await verifyMessage({ address: h.operator, message: operatorMessage(h.worker), signature: h.operatorSig })
  } catch {
    return false
  }
}
