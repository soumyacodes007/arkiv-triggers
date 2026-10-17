// The webhook action: a signed POST to the rule's URL, retried with backoff.
// Public workers refuse private and loopback addresses, so a public rule cannot make our worker
// call into the network it runs in.

import { lookup } from "node:dns/promises"
import { isIP } from "node:net"
import { fillMessage } from "../schema"
import { WEBHOOK_HEADERS, type WebhookBody } from "../webhook"
import type { ActionContext, ActionRunner } from "./types"

const TIMEOUT_MS = 10_000
/** All attempts of one firing together, well inside the 60 s claim lease. */
const BUDGET_MS = 30_000

function isPrivate(ip: string): boolean {
  if (isIP(ip) === 6) {
    const v = ip.toLowerCase()
    if (v === "::1" || v === "::") return true
    if (v.startsWith("fc") || v.startsWith("fd") || v.startsWith("fe8") || v.startsWith("fe9") || v.startsWith("fea") || v.startsWith("feb")) return true
    const mapped = v.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)
    return mapped ? isPrivate(mapped[1]) : false
  }
  const [a, b] = ip.split(".").map(Number)
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    a >= 224
  )
}

/** Refuses URLs that resolve to private, loopback or link-local addresses. */
export async function assertPublicUrl(url: string): Promise<void> {
  const u = new URL(url)
  const host = u.hostname.replace(/^\[|\]$/g, "")
  const addresses = isIP(host) ? [host] : (await lookup(host, { all: true })).map((r) => r.address)
  if (addresses.length === 0 || addresses.some(isPrivate)) throw new Error(`refusing to call ${u.hostname}: it resolves to a private address`)
}

export function webhookBody(ctx: ActionContext, test = false): WebhookBody {
  const { rule } = ctx
  return {
    event: ctx.eventId,
    rule: rule.key,
    ruleName: rule.name,
    trigger: rule.trigger.on,
    target: rule.trigger.on === "expire" ? rule.trigger.target : undefined,
    deadline: ctx.deadline.toString(),
    firedAt: ctx.firedAt.toString(),
    message: rule.message
      ? fillMessage(rule.message, { entity: rule.trigger.on === "expire" ? rule.trigger.target : "-", time: ctx.timeText, rule: rule.name ?? rule.key })
      : undefined,
    worker: ctx.account.address,
    ...(test ? { test: true } : {}),
  }
}

export const runWebhook: ActionRunner = async (ctx) => {
  const url = ctx.rule.url
  if (!url) return { ok: false, result: { error: "the rule has no url" } }
  try {
    if (!ctx.allowLocal) await assertPublicUrl(url)
  } catch (e) {
    return { ok: false, result: { error: (e as Error).message, attempts: 0 } }
  }
  const body = JSON.stringify(webhookBody(ctx))
  const signature = await ctx.account.signMessage({ message: body })
  const tries = Math.max(1, (ctx.rule.retries ?? 3) + 1)
  const begun = Date.now()
  let last: { code?: number; error?: string; latencyMs?: number } = {}
  let attempt = 1
  for (; attempt <= tries; attempt++) {
    const started = Date.now()
    try {
      const res = await ctx.fetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          [WEBHOOK_HEADERS.signature]: signature,
          [WEBHOOK_HEADERS.worker]: ctx.account.address,
          [WEBHOOK_HEADERS.rule]: ctx.rule.key,
          [WEBHOOK_HEADERS.event]: ctx.eventId,
        },
        body,
        redirect: "manual",
        signal: AbortSignal.timeout(TIMEOUT_MS),
      })
      last = { code: res.status, latencyMs: Date.now() - started }
      if (res.ok) return { ok: true, result: { ...last, attempts: attempt } }
      // A 4xx other than 408/429 will not get better on retry.
      if (res.status >= 400 && res.status < 500 && res.status !== 408 && res.status !== 429) break
    } catch (e) {
      last = { error: (e as Error).message, latencyMs: Date.now() - started }
    }
    if (attempt === tries) break
    // Stay inside the 60 s claim lease: another worker may take the rule over once it lapses.
    const wait = 2_000 * 2 ** (attempt - 1)
    if (Date.now() - begun + wait + TIMEOUT_MS > BUDGET_MS) break
    await new Promise((r) => setTimeout(r, wait))
  }
  return { ok: false, result: { ...last, attempts: Math.min(attempt, tries) } }
}
