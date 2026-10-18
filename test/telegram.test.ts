import assert from "node:assert/strict"
import { test } from "node:test"
import { startTelegramLinking } from "../src/actions/telegram"

test("an idle Telegram poll can finish its server-side wait without being aborted", { timeout: 40_000 }, async (t) => {
  const logs: string[] = []
  let stop: () => void
  let finished: () => void
  const done = new Promise<void>((resolve) => { finished = resolve })
  const fetchFn: typeof fetch = async (url, init) => {
    assert.ok(String(url).endsWith("/getUpdates"))
    const body = JSON.parse(String(init?.body))
    return new Promise<Response>((resolve, reject) => {
      const timer = setTimeout(() => {
        stop()
        resolve(new Response(JSON.stringify({ ok: true, result: [] })))
        finished()
      }, body.timeout * 1000)
      init?.signal?.addEventListener("abort", () => {
        clearTimeout(timer)
        stop()
        reject(init.signal?.reason)
        finished()
      }, { once: true })
    })
  }
  stop = startTelegramLinking("test-token", { fetch: fetchFn, log: (line) => logs.push(line) })
  t.after(() => stop())
  await done
  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.deepEqual(logs, [], "a normal empty poll must not log an abort or enter error backoff")
})
