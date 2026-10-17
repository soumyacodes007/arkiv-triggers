import type { ActionRunner } from "./types"

/** The receipt itself is the action: apps watch for it on Arkiv. */
export const runReceipt: ActionRunner = async () => ({ ok: true, result: { attempts: 1 } })
