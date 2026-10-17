// Paged Arkiv queries with a deadline. A rate-limited client (HTTP 429, e.g. an exhausted anonymous
// budget) does not get an error through the SDK: the transport waits out Retry-After, so a query
// can hang for minutes (arkiv/friction.md #10). Every query here fails after a timeout instead.

/** How long one query, all its pages together, may take. */
export const QUERY_TIMEOUT_MS = 30_000

export class QueryTimeoutError extends Error {}

/**
 * One log line for an error. viem's messages span lines (request body first), so a cut-off message hid
 * the part that matters; an exhausted access key showed only "HTTP request failed." (friction #12).
 */
export function describeError(e: unknown, max = 200): string {
  const err = e as { shortMessage?: string; message?: string; status?: number; details?: string }
  const details = String(err?.details ?? "").replace(/^"|"$/g, "")
  if (err?.status === 429 && details === "QUOTA_EXCEEDED") return "Arkiv quota for this access key is used up (429 QUOTA_EXCEEDED); use another ARKIV_ACCESS_KEY"
  if (err?.status === 429 && /ANON_COST_LIMITED/.test(details)) return "Arkiv's anonymous query budget is used up (429); set ARKIV_ACCESS_KEY"
  const head = (err?.shortMessage ?? err?.message ?? String(e)).split("\n")[0]
  return [head, err?.status && `status ${err.status}`, details].filter(Boolean).join(" · ").slice(0, max)
}

/** Pages through a query pinned to one block (Arkiv cursors belong to the block they were read at). */
export async function pageAll<T>(
  reader: any,
  build: (c: any) => any,
  map: (e: any) => T | undefined,
  opts: { at?: bigint; timeoutMs?: number } = {},
): Promise<T[]> {
  const ms = opts.timeoutMs ?? QUERY_TIMEOUT_MS
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () =>
        reject(
          new QueryTimeoutError(
            `an Arkiv query took over ${ms / 1000} s; the node may be rate-limiting this client. Use an access key (ARKIV_ACCESS_KEY, or accessKey in code)`,
          ),
        ),
      ms,
    )
  })
  const run = async () => {
    const head: bigint = opts.at ?? (await reader.getBlockNumber())
    const out: T[] = []
    for await (const e of build(reader).limit(200).atBlock(head)) {
      const v = map(e)
      if (v !== undefined) out.push(v)
    }
    return out
  }
  try {
    return await Promise.race([run(), timeout])
  } finally {
    clearTimeout(timer)
  }
}
