import type { ActionName } from "../schema"
import { runExtend } from "./extend"
import { runReceipt } from "./receipt"
import { runTelegram } from "./telegram"
import type { ActionRunner } from "./types"
import { runWebhook } from "./webhook"

/** The worker side of the fixed action menu (the definitions are in schema.ts as ACTIONS). */
export const RUNNERS: Record<ActionName, ActionRunner> = {
  receipt: runReceipt,
  webhook: runWebhook,
  telegram: runTelegram,
  extend: runExtend,
}

export type { ActionContext, ActionOutcome, ActionRunner } from "./types"
export { startTelegramLinking } from "./telegram"
export { assertPublicUrl, webhookBody } from "./webhook"
