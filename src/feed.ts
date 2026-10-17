// One self-healing subscription to Arkiv's entity events, shared by the worker and the SDK's watch().
// viem's own socket reconnect is turned off: after its retries it leaves the dead socket cached under the
// URL, so every later subscription fails at once, and onError fires once per failed request, not once per
// outage. Reconnecting on every onError call therefore multiplied subscriptions on a dead socket
// (arkiv/friction.md #11). Here only the current connection may reconnect, once, after closing its socket.
import { createPublicClient } from "@arkiv-network/sdk"
import { tiramisu } from "@arkiv-network/sdk/chains"
import { webSocket } from "viem"

export const FEED_BACKOFF_MS = [1_000, 2_000, 5_000, 10_000]

type Handler = (e: any) => void
export type FeedHandlers = { onEvent?: Handler; onEntityCreated?: Handler; onEntityDeleted?: Handler; onExpiryExtended?: Handler }
export type FeedStatus = { onUp?: () => void; onDown?: (err: Error) => void }

/** Makes the client one connection uses; tests pass a fake. */
export type FeedClientFactory = (wsUrl: string) => any
const defaultClient: FeedClientFactory = (wsUrl) =>
  createPublicClient({ chain: tiramisu, transport: webSocket(wsUrl, { reconnect: false }) })

export function followEvents(
  wsUrl: string,
  handlers: FeedHandlers,
  status: FeedStatus = {},
  opts: { client?: FeedClientFactory; backoffMs?: number[] } = {},
): () => void {
  const backoff = opts.backoffMs ?? FEED_BACKOFF_MS
  let stopped = false
  let gen = 0
  let attempt = 0
  let timer: ReturnType<typeof setTimeout> | undefined
  let closeCurrent: (() => void) | undefined

  const connect = () => {
    if (stopped) return
    const my = ++gen
    const live = () => my === gen && !stopped
    const ws = (opts.client ?? defaultClient)(wsUrl)
    let stop: (() => void) | undefined
    let failed = false
    const close = () => {
      try {
        stop?.()
      } catch {}
      // Closing the socket client also evicts it from viem's cache, so the next connect gets a fresh one.
      Promise.resolve(ws.transport?.getRpcClient?.())
        .then((c: any) => c?.close())
        .catch(() => {})
    }
    const wrapped = Object.fromEntries(
      Object.entries(handlers).map(([k, fn]) => [
        k,
        (e: any) => {
          if (!live()) return
          attempt = 0
          fn?.(e)
        },
      ]),
    )
    stop = ws.watchEntityEvents({
      ...wrapped,
      onError: (err: Error) => {
        if (!live()) return // a connection we already gave up on, or a second error from this one
        gen++
        failed = true
        close()
        status.onDown?.(err)
        timer = setTimeout(connect, backoff[Math.min(attempt++, backoff.length - 1)])
      },
    })
    if (failed) close() // failed before watchEntityEvents returned its stop function
    closeCurrent = close
    if (!failed) status.onUp?.()
  }

  connect()
  return () => {
    stopped = true
    clearTimeout(timer)
    closeCurrent?.()
  }
}
