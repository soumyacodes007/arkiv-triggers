// startWorker: watches rules on Arkiv, fires them at the right moment, and signs receipts.
//
// The loop, every few seconds:
//   1. load the rules this worker may fire (refreshed when the event feed says something changed);
//   2. work out each rule's deadline block: its fire block, or its target's expiry minus the offset;
//   3. for each rule that is due, confirm it (an expire rule's target must really have expired, not
//      been deleted or extended), claim it with a 60-second lease, and let the oldest claim win;
//   4. the winner runs the action from the fixed menu and writes a receipt signed by its own wallet.
// A heartbeat entity, renewed every minute, says the worker is alive and how far it has got.
// Workers never talk to each other: claims and receipts on Arkiv are the only coordination.

import { type CreateEntityParameters, ENTITY_EVENTS_ABI, ExpirationTime, createPublicClient, createWalletClient, str, u64 } from "@arkiv-network/sdk"
import { tiramisu } from "@arkiv-network/sdk/chains"
import { and, eq, gte } from "@arkiv-network/sdk/query"
import { type Hex, encodePacked, http, keccak256 } from "viem"
import { privateKeyToAccount } from "viem/accounts"
import { RUNNERS, startTelegramLinking } from "./actions/index"
import type { ActionOutcome } from "./actions/types"
import {
  ACTIONS,
  ACTION_NAMES,
  type ActionName,
  LIFETIMES,
  type Claim,
  type Rule,
  TYPES,
  claimToCreate,
  claimWinner,
  deadlineOf,
  heartbeatAttributes,
  heartbeatToCreate,
  parseClaim,
  parseHeartbeat,
  parseReceipt,
  parseRule,
  receiptToCreate,
} from "./schema"
import { followEvents } from "./feed"
import { describeError, pageAll } from "./query"
import { workerSealKeys } from "./seal"
import { type BlockClock, toDate } from "./time"

export const WORKER_VERSION = "arkiv-triggers/0.1.1"
const DEFAULT_RPC_URL = "https://rpc.tiramisu.db-chain.testnet.arkiv.network"
const DEFAULT_WS_URL = "wss://rpc.tiramisu.db-chain.testnet.arkiv.network"
/** Where Arkiv emits its entity events. Not exported by the SDK (see arkiv/friction.md). */
const ARKIV_EVENTS_ADDRESS = "0x4400000000000000000000000000000000000044" as const
/** How far back each incremental receipt scan reaches, for receipts written a while after firing (retries). */
const RECEIPT_SCAN_MARGIN = 300n
/** Act on a claim only with at least this much lease left at the deadline (36 s: a 30 s action budget plus the receipt). */
const MIN_LEASE_BLOCKS = 18n
/** Claim this many blocks ahead of a deadline, so the claim is settled when the block arrives. */
const CLAIM_LEAD_BLOCKS = 8n
/** At most this many writes go in one transaction. */
const MAX_BATCH_WRITES = 60
/** At most this many rules are fired together, in one claim transaction and one receipt transaction. */
const MAX_BATCH = 50
const DELETED_EVENT = ENTITY_EVENTS_ABI.find((e: any) => e.type === "event" && e.name === "EntityDeleted") as any

export type FireInfo = { deadline: bigint; firedAt: bigint; eventId: Hex }

export type WorkerOptions = {
  /** The worker's own wallet key. Never the user's main wallet. */
  privateKey: Hex
  /** "any": fire public rules and rules assigned to this worker. "own": only rules assigned to it. */
  mode?: "any" | "own"
  /** The owner's main wallet, and its signature linking it to this worker (for the dashboard). */
  operator?: Hex
  operatorSig?: Hex
  /** Enables the Telegram action (and the /start linking bot). */
  telegramToken?: string
  /** Answer /start with a chat code. Default: on when telegramToken is set. */
  telegramLinking?: boolean
  /** Run your own code when one of your own rules fires. Never called for public rules. */
  onFire?: (rule: Rule, info: FireInfo) => Promise<void> | void
  rpcUrl?: string
  wsUrl?: string
  accessKey?: string
  /** How often to check deadlines. Default 4000 ms (two blocks). */
  pollMs?: number
  /** Least time between two full rule reloads when the event feed says something changed (default 30 s).
   * The feed is unfiltered, so on a busy chain it says so every block; each reload is several queries. */
  reloadMs?: number
  /** How often to renew the heartbeat. Default 60000 ms. */
  heartbeatMs?: number
  /** Development only: let webhooks reach localhost and private addresses. */
  allowLocal?: boolean
  /** Only consider rules written with this `app` attribute (useful for tests). */
  app?: string
  log?: (line: string) => void
  fetch?: typeof fetch
}

export type WorkerStats = { rules: number; fired: number; failed: number; skipped: number; lastBlock: bigint; heartbeat?: Hex }

export type WorkerHandle = {
  address: Hex
  /** The public key apps seal Telegram chat IDs to (also published in the heartbeat). */
  sealKey: Hex
  stats: () => WorkerStats
  /** One pass of the loop, for tests. */
  tick: () => Promise<void>
  stop: () => Promise<void>
}

type WriteOp =
  | { create: CreateEntityParameters }
  | { patch: { entityKey: Hex; set: Record<string, unknown> } }
  | { extend: { entityKey: Hex; expires: unknown } }
type WriteJob = { op: WriteOp; resolve: (key: Hex | undefined) => void; reject: (e: unknown) => void }

/**
 * The worker's one writer (one wallet, one writer: nonces and entity keys depend on it), with group
 * commit: whatever is waiting when the previous transaction confirms goes out together in one
 * `executeBatch`. Throughput then grows with the batch, not with the number of writes. Priority
 * writes (receipts, extensions) go first, so a receipt lands inside its claim's lease. If a batch
 * fails, its writes are retried one by one so one bad write cannot sink the others.
 */
class Writer {
  #high: WriteJob[] = []
  #low: WriteJob[] = []
  #busy = false
  constructor(private wallet: any) {}

  /** Queues one write; resolves with the new entity key for a create. */
  submit(op: WriteOp, priority = false): Promise<Hex | undefined> {
    return new Promise((resolve, reject) => {
      ;(priority ? this.#high : this.#low).push({ op, resolve, reject })
      void this.#pump()
    })
  }

  async #pump() {
    if (this.#busy) return
    this.#busy = true
    try {
      while (this.#high.length || this.#low.length) {
        const jobs = [...this.#high.splice(0, MAX_BATCH_WRITES)]
        jobs.push(...this.#low.splice(0, MAX_BATCH_WRITES - jobs.length))
        try {
          await this.#send(jobs)
        } catch (e) {
          if (jobs.length === 1) jobs[0].reject(e)
          else for (const j of jobs) await this.#send([j]).catch(j.reject)
        }
      }
    } finally {
      this.#busy = false
    }
  }

  async #send(jobs: WriteJob[]) {
    const creates = jobs.filter((j) => "create" in j.op)
    const patches = jobs.flatMap((j) => ("patch" in j.op ? [j.op.patch] : []))
    const extensions = jobs.flatMap((j) => ("extend" in j.op ? [j.op.extend] : []))
    const res = await this.wallet.executeBatch({
      ...(creates.length ? { creates: creates.map((j) => (j.op as { create: CreateEntityParameters }).create) } : {}),
      ...(patches.length ? { patches } : {}),
      ...(extensions.length ? { extensions } : {}),
    })
    // createdEntities come back in the order of `creates` (checked on Tiramisu).
    creates.forEach((j, i) => j.resolve(res.createdEntities[i]))
    for (const j of jobs) if (!("create" in j.op)) j.resolve(undefined)
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const lower = (h: string) => h.toLowerCase()

export async function startWorker(opts: WorkerOptions): Promise<WorkerHandle> {
  const log = opts.log ?? ((line: string) => console.log(`[arkiv-triggers] ${line}`))
  const mode = opts.mode ?? "any"
  const account = privateKeyToAccount(opts.privateKey)
  const me = lower(account.address)
  const headers = opts.accessKey ? { "X-API-KEY": opts.accessKey } : undefined
  const transport = () => http(opts.rpcUrl ?? DEFAULT_RPC_URL, headers ? { fetchOptions: { headers } } : {})
  const reader: any = createPublicClient({ chain: tiramisu, transport: transport() })
  const wallet: any = createWalletClient({ chain: tiramisu, transport: transport(), account })
  const writer = new Writer(wallet)
  const sealKey = workerSealKeys(opts.privateKey).publicKey
  const fetchFn = opts.fetch ?? fetch
  const actions: ActionName[] = ACTION_NAMES.filter((a) => a !== "telegram" || !!opts.telegramToken)

  const rules = new Map<string, Rule>()
  const done = new Set<string>()
  const inFlight = new Set<string>()
  /** Rules another worker holds a live claim on, and until when (block). */
  const backoff = new Map<string, bigint>()
  const targets = new Map<string, { expiresAt?: bigint; gone: boolean; checkedAt: number }>()
  const stats: WorkerStats = { rules: 0, fired: 0, failed: 0, skipped: 0, lastBlock: 0n }
  let rulesDirty = true
  let lastLoad = 0
  const reloadMs = opts.reloadMs ?? 30_000
  let stopped = false
  let heartbeatKey: Hex | undefined
  let receiptScanFrom: bigint | undefined

  const all = <T>(build: (c: any) => any, map: (e: any) => T | undefined, at?: bigint) => pageAll(reader, build, map, { at })
  const FULL = { key: true, creator: true, owner: true, createdAt: true, expiresAt: true, attributes: true, payload: true } as const

  /** Rules this worker may fire, by its mode and the rule's `worker` field. */
  function mayFire(rule: Rule): boolean {
    const assigned = lower(rule.worker)
    if (assigned !== "any" && assigned !== me) return false
    if (mode === "own" && assigned !== me) return false
    if (rule.action === "telegram" && !opts.telegramToken) return false
    return true
  }

  async function loadRules() {
    const where = [eq("type", str(TYPES.rule))]
    if (opts.app) where.push(eq("app", str(opts.app)))
    const found = await all((c) => c.select(FULL).where(and(where)), parseRule)
    rules.clear()
    for (const r of found) if (mayFire(r)) rules.set(lower(r.key), r)
    // Receipts that already exist for these rules: those rules are finished. The first scan reads every
    // receipt; later ones only those fired since the last scan (fire() re-checks per rule anyway).
    const head: bigint = await reader.getBlockNumber()
    const rw = [eq("type", str(TYPES.receipt))]
    if (receiptScanFrom !== undefined) rw.push(gte("firedat", u64(receiptScanFrom > RECEIPT_SCAN_MARGIN ? receiptScanFrom - RECEIPT_SCAN_MARGIN : 0n)))
    const receipts = await all((c) => c.select({ key: true, creator: true, attributes: true }).where(and(rw)), parseReceipt, head)
    for (const r of receipts) done.add(lower(r.rule))
    receiptScanFrom = head
    stats.rules = rules.size
    rulesDirty = false
    lastLoad = Date.now()
  }

  /** A target's expiry. Extensions and deletes arrive as events, so a target far from its deadline is
   * re-read every 10 minutes, and one within 10 minutes of it every 30 s; firing always re-reads it. */
  async function targetState(target: Hex, fresh = false, head?: bigint) {
    const k = lower(target)
    const cached = targets.get(k)
    const far = cached?.expiresAt !== undefined && head !== undefined && cached.expiresAt - head > 300n
    if (cached && !fresh && Date.now() - cached.checkedAt < (far ? 600_000 : 30_000)) return cached
    let state: { expiresAt?: bigint; gone: boolean; checkedAt: number }
    try {
      const e = await reader.getEntity(target)
      state = { expiresAt: e.expiresAt as bigint, gone: false, checkedAt: Date.now() }
    } catch {
      state = { expiresAt: cached?.expiresAt, gone: true, checkedAt: Date.now() }
    }
    targets.set(k, state)
    return state
  }

  /** Was this entity deleted (rather than expired) since `fromBlock`? Arkiv's event logs say. */
  async function wasDeleted(target: Hex, fromBlock: bigint, head: bigint): Promise<boolean> {
    const step = 10_000n
    for (let from = fromBlock; from <= head; from += step) {
      const to = from + step - 1n > head ? head : from + step - 1n
      const logs = await reader.getLogs({ address: ARKIV_EVENTS_ADDRESS, event: DELETED_EVENT, args: { entityKey: target }, fromBlock: from, toBlock: to })
      if (logs.length) return true
    }
    return false
  }

  let clockCache: { clock: BlockClock; at: number } | undefined
  async function timeText(block: bigint): Promise<string> {
    if (!clockCache || Date.now() - clockCache.at > 60_000) {
      const t = await reader.getBlockTiming()
      clockCache = { clock: { block: t.currentBlock, timeMs: Number(t.currentBlockTime) * 1000 }, at: Date.now() }
    }
    return toDate(block, clockCache.clock).toISOString().replace("T", " ").slice(0, 16) + " UTC"
  }

  type Due = { rule: Rule; deadline: bigint }
  type Ready = Due & { skip: boolean; reason: string }
  type Held = Due & { claimKey: Hex; leaseEnds: bigint }
  type Done = Ready & { status: "ok" | "failed" | "skipped"; result: ActionOutcome["result"]; firedAt: bigint }

  /** Every live claim on the chain, grouped by rule. Claims live 60 s, so this set stays small. */
  async function liveClaims(): Promise<Map<string, Claim[]>> {
    const out = new Map<string, Claim[]>()
    const claims = await all((c) => c.select({ key: true, createdAt: true, expiresAt: true, attributes: true }).where(eq("type", str(TYPES.claim))), parseClaim)
    for (const c of claims) out.set(lower(c.rule), [...(out.get(lower(c.rule)) ?? []), c])
    return out
  }

  /** Is the rule due now, and should it fire or be recorded as skipped? Undefined: not due after all. */
  async function confirm({ rule, deadline }: Due, head: bigint): Promise<Ready | undefined> {
    if (rule.trigger.on === "block") return { rule, deadline, skip: false, reason: "block reached" }
    const t = await targetState(rule.trigger.target, true)
    if (!t.gone) {
      if (deadlineOf(rule.trigger, t.expiresAt) > head) return undefined // extended: due again at its new deadline
      return { rule, deadline, skip: false, reason: "target is about to expire" }
    }
    if (await wasDeleted(rule.trigger.target, rule.createdAt, head)) return { rule, deadline, skip: true, reason: "the target was deleted before it expired" }
    return { rule, deadline, skip: false, reason: "target expired" }
  }

  /**
   * Fires a set of rules that are due (or about to be) together: one transaction for all the claims
   * and one per deadline for the receipts, so throughput does not depend on how many come due at once.
   */
  async function fireBatch(items: Due[], _head: bigint) {
    for (const it of items) inFlight.add(lower(it.rule.key))
    try {
      // 1. Claim, a few blocks before the deadline, so the claim costs no time at the deadline. A rule
      //    someone else holds is left alone until their lease lapses.
      const before = await liveClaims()
      const toClaim: Due[] = []
      const contenders: Due[] = []
      for (const it of items) {
        const k = lower(it.rule.key)
        const w = claimWinner(before.get(k) ?? [])
        if (!w) toClaim.push(it)
        else if (lower(w.worker) === me) contenders.push(it) // ours, e.g. from before a restart
        else backoff.set(k, w.expiresAt)
      }
      if (toClaim.length) {
        await Promise.all(toClaim.map((r) => writer.submit({ create: claimToCreate(r.rule.key, account.address, r.deadline) })))
        contenders.push(...toClaim)
      }
      if (!contenders.length) return

      // 2. Decide once a query shows our own claims: any rival claim from the same or an earlier block is
      //    then visible too (reads can lag a write, friction #5), and a later one loses anyway.
      const mineVisible = (m: Map<string, Claim[]>, r: Due) => (m.get(lower(r.rule.key)) ?? []).some((c) => lower(c.worker) === me)
      let claims = await liveClaims()
      for (let i = 0; i < 10 && !contenders.every((r) => mineVisible(claims, r)); i++) {
        await sleep(1_000)
        claims = await liveClaims()
      }
      const won: Held[] = []
      for (const r of contenders) {
        if (!mineVisible(claims, r)) continue // not visible yet: retry on a later tick
        const w = claimWinner(claims.get(lower(r.rule.key)) ?? [])!
        if (lower(w.worker) === me) won.push({ ...r, claimKey: w.key, leaseEnds: w.expiresAt })
        else backoff.set(lower(r.rule.key), w.expiresAt)
      }

      // 3. Fire each deadline's rules the moment that block arrives (independently, so one slow group
      //    never delays the next).
      const deadlines = [...new Set(won.map((r) => r.deadline))]
      await Promise.all(deadlines.map((d) => fireAt(d, won.filter((r) => r.deadline === d))))
    } catch (e) {
      log(`batch of ${items.length}: ${describeError(e)}`)
    } finally {
      for (const it of items) inFlight.delete(lower(it.rule.key))
    }
  }

  async function untilBlock(b: bigint): Promise<bigint> {
    for (;;) {
      const head: bigint = await reader.getBlockNumber()
      if (head >= b || stopped) return head
      await sleep(500)
    }
  }

  async function fireAt(deadline: bigint, held: Held[]) {
    const now = await untilBlock(deadline)
    if (stopped) return
    // Act only with enough lease left to act and write the receipt before anyone else may take over.
    // A lease running short is ours to extend while it is still live; one about to lapse is let go.
    const short = held.filter((r) => r.leaseEnds - now < MIN_LEASE_BLOCKS && r.leaseEnds - now >= 3n)
    if (short.length) {
      await Promise.all(short.map((r) => writer.submit({ extend: { entityKey: r.claimKey, expires: ExpirationTime.fromSeconds(LIFETIMES.claimSeconds) } }, true)))
      for (const r of short) r.leaseEnds = now + BigInt(LIFETIMES.claimSeconds / 2)
    }
    const leased = held.filter((r) => {
      if (r.leaseEnds - now >= MIN_LEASE_BLOCKS) return true
      backoff.set(lower(r.rule.key), r.leaseEnds)
      return false
    })

    // Confirm each rule now that it is due: an expire rule's target may have been extended or deleted.
    const confirmed = await Promise.all(
      leased.map((r) => confirm(r, now).catch((e) => void log(`rule ${r.rule.key.slice(0, 10)}…: ${(e as Error).message}`))),
    )
    const ready = confirmed.filter((r): r is Ready => !!r)
    if (!ready.length) return

    // Another worker may have finished between our reads: check for receipts once more.
    const from = deadline > RECEIPT_SCAN_MARGIN ? deadline - RECEIPT_SCAN_MARGIN : 0n
    const finished = new Set(
      await all(
        (c) => c.select({ key: true, attributes: true }).where(and(eq("type", str(TYPES.receipt)), gte("firedat", u64(from)))),
        (e) => lower(String(e.attributes?.rule?.value ?? "")),
      ),
    )
    const acting = ready.filter((r) => {
      if (!finished.has(lower(r.rule.key))) return true
      done.add(lower(r.rule.key))
      return false
    })
    if (!acting.length) return

    // Act, in parallel. Each action stays well inside the lease (webhooks have a time budget).
    const results: Done[] = await Promise.all(
      acting.map(async (r): Promise<Done> => {
        if (r.skip) return { ...r, status: "skipped", result: { attempts: 0 }, firedAt: now }
        const outcome = await runAction(r, now).catch((e): ActionOutcome => ({ ok: false, result: { error: (e as Error).message.slice(0, 200) } }))
        return { ...r, status: outcome.ok ? "ok" : "failed", result: outcome.result, firedAt: now }
      }),
    )

    // Receipts go ahead of any queued claims, batched with whatever else is waiting.
    await Promise.all(
      results.map((d) =>
        writer.submit(
          {
            create: receiptToCreate({
              rule: d.rule.key,
              ruleCreator: d.rule.creator,
              action: d.rule.action,
              status: d.status,
              deadline: d.deadline,
              firedAt: d.firedAt,
              result: d.result,
              reason: d.reason,
            }),
          },
          true,
        ),
      ),
    )
    for (const d of results) {
      done.add(lower(d.rule.key))
      if (d.status === "ok") stats.fired++
      else if (d.status === "failed") stats.failed++
      else stats.skipped++
      log(`${d.status} ${d.rule.action} for rule ${d.rule.key.slice(0, 10)}… (${d.reason}${d.result.error ? `: ${d.result.error}` : ""})`)
    }
  }

  async function runAction({ rule, deadline }: Ready, firedAt: bigint): Promise<ActionOutcome> {
    const eventId = keccak256(encodePacked(["bytes32", "uint64"], [rule.key, deadline]))
    const outcome = await RUNNERS[rule.action]({
      rule,
      deadline,
      firedAt,
      timeText: await timeText(deadline),
      eventId,
      account,
      workerKey: opts.privateKey,
      // The worker's own writes go through its one writer (nonces), ahead of new claims.
      wallet: {
        extendEntity: async (p: { entityKey: Hex; expires: unknown }) => {
          await writer.submit({ extend: p }, true)
          return { expiresAt: await reader.getEntity(p.entityKey).then((e: any) => e.expiresAt, () => undefined) }
        },
      },
      telegramToken: opts.telegramToken,
      allowLocal: opts.allowLocal,
      fetch: fetchFn,
    })
    if (opts.onFire && lower(rule.worker) === me) {
      try {
        await opts.onFire(rule, { deadline, firedAt, eventId })
      } catch (e) {
        return { ok: false, result: { ...outcome.result, error: `onFire: ${(e as Error).message}`.slice(0, 200) } }
      }
    }
    return outcome
  }

  let ticking = false
  async function tick() {
    if (stopped || ticking) return // a slow pass (a big rule reload) must not pile up behind itself
    ticking = true
    try {
      const head: bigint = await reader.getBlockNumber()
      const since = Date.now() - lastLoad
      if ((rulesDirty && since >= reloadMs) || since >= 2 * reloadMs) await loadRules()
      const open = [...rules].filter(([k]) => {
        if (done.has(k) || inFlight.has(k)) return false
        const wait = backoff.get(k)
        return wait === undefined || head > wait
      })
      // Refresh expire rules' targets 16 at a time (each is a getEntity; cached for 30 s).
      const targetsOf = open.flatMap(([, r]) => (r.trigger.on === "expire" ? [r.trigger.target] : []))
      for (let i = 0; i < targetsOf.length; i += 16) await Promise.all(targetsOf.slice(i, i + 16).map((t) => targetState(t, false, head)))
      const due: Due[] = []
      for (const [, rule] of open) {
        if (due.length >= MAX_BATCH) break
        let deadline: bigint
        if (rule.trigger.on === "block") deadline = deadlineOf(rule.trigger)
        else {
          const t = await targetState(rule.trigger.target)
          if (t.expiresAt === undefined && t.gone) deadline = head // gone before we ever saw it: confirm now
          else deadline = deadlineOf(rule.trigger, t.expiresAt)
        }
        if (deadline <= head + CLAIM_LEAD_BLOCKS) due.push({ rule, deadline })
      }
      if (due.length) void fireBatch(due, head)
      stats.lastBlock = head
    } finally {
      ticking = false
    }
  }

  // ---- heartbeat ------------------------------------------------------------------------------

  const heartbeatInput = () => ({
    version: WORKER_VERSION,
    mode,
    lastBlock: stats.lastBlock,
    actions,
    operator: opts.operator,
    operatorSig: opts.operatorSig,
    sealKey,
  })

  async function heartbeat() {
    if (heartbeatKey) {
      try {
        // One tx: new attributes go under `set` (an `attributes` key is silently ignored, see friction #7).
        const entityKey = heartbeatKey
        await Promise.all([
          writer.submit({ patch: { entityKey, set: heartbeatAttributes(heartbeatInput()) } }),
          writer.submit({ extend: { entityKey, expires: ExpirationTime.fromSeconds(LIFETIMES.heartbeatSeconds) } }),
        ])
        stats.heartbeat = heartbeatKey
        return
      } catch (e) {
        log(`heartbeat renewal failed (${describeError(e)}); writing a new one`)
      }
    }
    heartbeatKey = await writer.submit({ create: heartbeatToCreate(heartbeatInput()) })
    stats.heartbeat = heartbeatKey
  }

  // ---- start ----------------------------------------------------------------------------------

  // Resume from our own heartbeat if it is still alive (a restart within its 5-minute life).
  const mine = await all((c) => c.select(FULL).where(eq("type", str(TYPES.heartbeat))).createdBy(account.address), parseHeartbeat)
  const latest = mine.sort((a, b) => (a.createdAt > b.createdAt ? -1 : 1))[0]
  if (latest) {
    // Renew it only if it will not lapse before the renewal lands; otherwise start a fresh one.
    if (latest.expiresAt - (await reader.getBlockNumber()) > 10n) heartbeatKey = latest.key
    stats.lastBlock = latest.lastBlock
    log(`resuming from block ${latest.lastBlock}`)
  }
  stats.lastBlock = stats.lastBlock || (await reader.getBlockNumber())
  await heartbeat()

  // The event feed only marks state stale; deadlines are checked by the loop, since expiry emits nothing.
  const stopEvents = followEvents(
    opts.wsUrl ?? DEFAULT_WS_URL,
    {
      onEntityCreated: () => {
        rulesDirty = true
      },
      onEntityDeleted: (e: any) => {
        rulesDirty = true
        targets.delete(lower(e.entityKey))
      },
      onExpiryExtended: (e: any) => {
        const t = targets.get(lower(e.entityKey))
        if (t) targets.set(lower(e.entityKey), { ...t, expiresAt: e.expiresAt, gone: false })
      },
    },
    {
      onDown: (err) => {
        log(`event feed: ${describeError(err, 120)}; reconnecting`)
        rulesDirty = true
      },
    },
  )

  const loop = setInterval(() => void tick().catch((e) => log(`tick: ${describeError(e)}`)), opts.pollMs ?? 4_000)
  const beat = setInterval(() => void heartbeat().catch((e) => log(`heartbeat: ${describeError(e)}`)), opts.heartbeatMs ?? LIFETIMES.heartbeatRenewSeconds * 1000)
  const stopLinking = opts.telegramToken && opts.telegramLinking !== false ? startTelegramLinking(opts.telegramToken, { fetch: fetchFn, log }) : undefined

  log(`worker running as ${account.address} (mode ${mode}, actions ${actions.map((a) => ACTIONS[a].icon + " " + a).join(", ")})`)

  return {
    address: account.address,
    sealKey,
    stats: () => ({ ...stats }),
    tick,
    stop: async () => {
      stopped = true
      clearInterval(loop)
      clearInterval(beat)
      stopEvents()
      stopLinking?.()
      while (inFlight.size) await sleep(200)
    },
  }
}
