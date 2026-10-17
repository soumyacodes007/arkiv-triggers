// The Telegram action, and the "tap Start, get your chat code" linking bot.
// The bot token lives only in the worker's environment. A rule carries the chat ID sealed to this
// worker, so only this worker can read where to send.

import { fillMessage } from "../schema"
import { openSealed } from "../seal"
import type { ActionRunner } from "./types"

const API = "https://api.telegram.org"
const TIMEOUT_MS = 10_000
/** All attempts of one firing together, well inside the claim lease (as for webhooks). */
const BUDGET_MS = 30_000

async function call(fetchFn: typeof fetch, token: string, method: string, body: unknown) {
  const res = await fetchFn(`${API}/bot${token}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  })
  const json = (await res.json().catch(() => ({}))) as { ok?: boolean; result?: any; description?: string }
  return { status: res.status, json }
}

export const runTelegram: ActionRunner = async (ctx) => {
  const { rule } = ctx
  if (!ctx.telegramToken) return { ok: false, result: { error: "this worker has no Telegram bot token" } }
  if (!rule.chat || !rule.message) return { ok: false, result: { error: "the rule has no sealed chat or message" } }
  let chatId: string
  try {
    chatId = openSealed(rule.chat, ctx.workerKey)
  } catch (e) {
    return { ok: false, result: { error: `cannot open the chat: ${(e as Error).message}` } }
  }
  const text = fillMessage(rule.message, {
    entity: rule.trigger.on === "expire" ? rule.trigger.target : "-",
    time: ctx.timeText,
    rule: rule.name ?? rule.key,
  })
  const tries = Math.max(1, (rule.retries ?? 3) + 1)
  const begun = Date.now()
  let last: { code?: number; error?: string; latencyMs?: number } = {}
  let attempt = 1
  for (; attempt <= tries; attempt++) {
    const started = Date.now()
    try {
      const { status, json } = await call(ctx.fetch, ctx.telegramToken, "sendMessage", { chat_id: chatId, text })
      last = { code: status, latencyMs: Date.now() - started }
      if (json.ok) return { ok: true, result: { ...last, messageId: json.result?.message_id, attempts: attempt } }
      last.error = json.description
      if (status >= 400 && status < 500 && status !== 429) break
    } catch (e) {
      last = { error: (e as Error).message, latencyMs: Date.now() - started }
    }
    if (attempt === tries) break
    const wait = 2_000 * 2 ** (attempt - 1)
    if (Date.now() - begun + wait + TIMEOUT_MS > BUDGET_MS) break
    await new Promise((r) => setTimeout(r, wait))
  }
  return { ok: false, result: { ...last, attempts: Math.min(attempt, tries) } }
}

/**
 * Answers "/start" with the chat's code, so a user can paste it into the dashboard, which seals it
 * to this worker. Long-polls getUpdates; returns a function that stops it.
 */
export function startTelegramLinking(token: string, opts: { fetch?: typeof fetch; log?: (s: string) => void } = {}): () => void {
  const fetchFn = opts.fetch ?? fetch
  let stopped = false
  let offset = 0
  void (async () => {
    while (!stopped) {
      try {
        const { json } = await call(fetchFn, token, "getUpdates", { offset, timeout: 25, allowed_updates: ["message"] })
        for (const u of json.result ?? []) {
          offset = u.update_id + 1
          const msg = u.message
          if (msg?.text?.trim().startsWith("/start")) {
            await call(fetchFn, token, "sendMessage", {
              chat_id: msg.chat.id,
              text: `Your Arkiv Triggers chat code is ${msg.chat.id}\n\nPaste it into the dashboard. It is sealed so only the Triggers worker can read it; it never goes on Arkiv in plain text.`,
            })
            opts.log?.("answered a /start with a chat code")
          }
        }
      } catch (e) {
        opts.log?.(`telegram linking: ${(e as Error).message}`)
        await new Promise((r) => setTimeout(r, 5_000))
      }
    }
  })()
  return () => {
    stopped = true
  }
}
