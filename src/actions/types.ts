import type { Hex, LocalAccount } from "viem"
import type { ReceiptResult, Rule } from "../schema"

/** Everything an action may use when a rule fires. Actions never see code from the rule. */
export type ActionContext = {
  rule: Rule
  /** The block the rule was due at, and the head when it fired. */
  deadline: bigint
  firedAt: bigint
  /** Human-readable deadline time, for {time} in messages. */
  timeText: string
  /** A stable ID for this firing, the same across retries, so receivers can drop duplicates. */
  eventId: Hex
  account: LocalAccount
  /** The worker's private key, used only to open sealed chat IDs. */
  workerKey: Hex
  /** An Arkiv wallet client for the worker's own writes (extend). */
  wallet: any
  telegramToken?: string
  /** Development only: let webhooks reach localhost and private addresses. */
  allowLocal?: boolean
  fetch: typeof fetch
}

export type ActionOutcome = { ok: boolean; result: ReceiptResult }

export type ActionRunner = (ctx: ActionContext) => Promise<ActionOutcome>
