import { ExpirationTime } from "@arkiv-network/sdk"
import type { ActionRunner } from "./types"

/** Extends the target. Works only if the target was created with permissionless extension. */
export const runExtend: ActionRunner = async (ctx) => {
  const { rule } = ctx
  if (rule.trigger.on !== "expire") return { ok: false, result: { error: "extend needs an entity target" } }
  const days = rule.extendDays ?? 0
  if (!(days > 0)) return { ok: false, result: { error: "the rule has no extendDays" } }
  const started = Date.now()
  try {
    const res = await ctx.wallet.extendEntity({ entityKey: rule.trigger.target, expires: ExpirationTime.fromDays(days) })
    return { ok: true, result: { latencyMs: Date.now() - started, attempts: 1, newExpiresAt: String(res.expiresAt ?? "") } }
  } catch (e) {
    const msg = (e as Error).message
    const hint = /permission|owner/i.test(msg) ? " (the target must be created with permissionlessExtension)" : ""
    return { ok: false, result: { error: msg.slice(0, 200) + hint, latencyMs: Date.now() - started, attempts: 1 } }
  }
}
