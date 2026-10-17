# Building on Arkiv: friction report

What got in our way while building Arkiv Triggers, and what worked as documented, logged the day we
hit it. Every entry names the versions and a script that reproduces it.

**Environment for every entry unless noted:** `@arkiv-network/sdk` 0.8.1 · `viem` 2.57.4 · Node 24.13.1 ·
Tiramisu (chain 7738577) · Windows 11 · 17 Oct 2026. Spike scripts read keys from `.env.local`.

## Issues

### 1. A bare number in a range query is an `i32`, so it silently matches nothing on a `u64` attribute

- **What we tried:** a rule entity with `fireat: u64(n)`, then `lte("fireat", Number(n + 1000))`.
- **What happened:** 0 results and no error. The same query with `lte("fireat", u64(n + 1000))` returns the rule.
- **What we expected:** either a match, or an error saying the comparison type does not match the attribute's type.
- **Why it matters:** a worker that forgets one `u64(...)` wrapper never finds a due rule, and nothing tells it so. It looks exactly like "no rules due".
- **Reproduce:** `npx tsx spike/01-u64-range.ts` (the "bare number" check).
- **What would fix it:** a typed-mismatch error from the node, or an SDK lint that flags untagged numbers in range operators. The SDK's JSDoc does say bare numbers default to `i32`, but the failure mode is silent.
- **Our workaround:** every compared number in the codebase goes through `u64(...)`; a unit test asserts the rule query string contains `u64(`.

### 2. An expiry emits no event, and `getEntity` cannot tell an expired entity from a deleted one

- **What we tried:** created one entity and deleted it, created another with `ExpirationTime.fromBlocks(5)` and let it lapse, then replayed events from before both and called `getEntity` on each.
- **What happened:** the replay shows `EntityCreated` + `EntityDeleted` for the first and only `EntityCreated` for the second. `getEntity` throws the same `NoEntityFoundError` for both.
- **What we expected:** an `EntityExpired` event, or at least a `getEntity` error that says "expired at block N" versus "deleted".
- **Why it matters:** this is the gap Arkiv Triggers exists to fill. A trigger "when this entity expires" must not fire when the owner deleted it early, so a worker has to keep its own record of deletes from the event stream and compare deadlines itself.
- **Reproduce:** `npx tsx spike/02-replay-events.ts`.
- **What would fix it:** an expiry event (even emitted lazily at the next block), or distinct error types.
- **Our workaround:** the worker schedules each deadline from the target's `$expiresAt`, records `EntityDeleted` events (replaying from its last saved block after a restart), and at the deadline treats "not found and not seen deleted" as expired.

### 3. Queries return no transaction or log index, so same-block ordering needs a second key

- **What we tried:** two `trg.claim` entities for the same rule in one `executeBatch`, plus one in a later block, then "oldest claim wins".
- **What happened:** the two batched claims share `$createdAt` (block 684324); the selection has no field for the transaction index or log index, so the query alone cannot say which came first.
- **What we expected:** a `$txIndex`/`$logIndex` (or a per-block sequence) in the selectable system fields.
- **Why it matters:** two workers claiming the same rule in the same block must agree on one winner without talking to each other.
- **Reproduce:** `npx tsx spike/03-claim-race.ts`.
- **What would fix it:** exposing the creation transaction and log index as selectable system attributes.
- **Our workaround:** winner = earliest `$createdAt`, ties broken by the lowest entity key. Every worker computes the same answer from the same query.

### 4. The RPC is open to browsers, but an access key cannot be, so browsers run on the anonymous quota

- **What we tried:** an `OPTIONS` preflight and a `POST` from a dashboard origin (`https://arkiv-triggers-dashboard.vercel.app`), with and without an `X-Api-Key` header.
- **What happened:** `204` with `access-control-allow-origin: *` and `X-Api-Key` in the allowed headers; the response exposes `Arkiv-Quota-Used-Percent` and `Arkiv-Cost`. So a static dashboard can read Arkiv directly, which is good. But a key in browser code is public, so a client-only app reads on the anonymous budget.
- **What we expected:** exactly this for CORS; for keys, a browser-safe option (an origin-restricted or read-only key) would let a static dashboard read without a proxy.
- **Reproduce:** the two `curl` commands in [spike/README.md](../spike/README.md).
- **Our workaround:** the dashboard reads snapshots with paged queries and then lives on the WebSocket feed, so it issues few queries; it watches `Arkiv-Quota-Used-Percent` and backs off.

### 5. A query right after a write resolves can still show the state before it

- **What we tried:** deleted three rules with `deleteEntity` (each awaited), then immediately listed rules with a query pinned to `getBlockNumber()`.
- **What happened:** the list still contained one of the three. A second query about a second later returned none. The same happens the other way: on 17 Oct, a list made right after `executeBatch` created rules showed 1 of 3 (a second later, all 3). Our claim protocol had to wait until a worker's own claim shows up in a query before deciding who won.
- **What we expected:** once `deleteEntity` resolves, a query at the current head no longer returns the entity.
- **Why it matters:** a dashboard that refreshes right after "Delete" shows the rule still there, and a worker that re-reads right after acting can act twice.
- **Reproduce:** `npm run test:live:sdk` without the retry loop around the final check (see the comment in `test/live/sdk.live.ts`).
- **What would fix it:** resolving writes only once the indexed state includes them, or returning the block the write landed in so readers can pin `atBlock` to it.
- **Our workaround:** the test polls for up to 10 s; the worker re-checks by entity key (`getEntity`) before acting rather than trusting a list.

### 6. The event feed cannot be filtered and carries no attributes

- **What we tried:** `watchEntityEvents` to follow new receipts and rules for one wallet.
- **What happened:** every handler receives every event on the chain (there is no filter parameter), and `EntityCreated` carries the key, owner, expiry and flags but no attributes or `$creator`, so telling a receipt from anything else means fetching each entity. Events do carry `transactionHash` and `logIndex`, which queries do not (see #3).
- **What we expected:** a filter (by attribute or creator), or attributes on `EntityCreated`.
- **Why it matters:** on a busy chain, fetching every created entity to find the few that matter is the expensive path.
- **Reproduce:** `npx tsx spike/02-replay-events.ts` and print the raw event objects.
- **Our workaround:** the SDK's `watch()` treats events only as a "something changed" signal and runs a few filtered queries (for example receipts with `firedat >=` the last one seen), at most once per second.

### 7. `patchEntity` ignores an unknown `attributes` key, then says there is nothing to apply

- **What we tried:** renewing a heartbeat with `patchEntity({ entityKey, attributes: {...} })`, the same key name `createEntity` uses.
- **What happened:** the SDK dropped `attributes` without complaint and threw "The patch for entity … has nothing to apply. Pass "set" to write attributes…". TypeScript did not catch it either, because the call site built the object through a helper typed loosely.
- **What we expected:** the same `attributes` key as `createEntity`, or a type error / an "unknown key `attributes`, did you mean `set`?" message.
- **Why it matters:** our worker's heartbeat renewal failed every minute and fell back to creating a new heartbeat entity each time, which doubled the write cost and left stale heartbeats until they expired. Nothing failed loudly.
- **Reproduce:** `npx tsx spike/04-heartbeat-patch.ts` (the first attempt uses `attributes`).
- **What would fix it:** accept `attributes` as an alias for `set`, or reject unknown keys by name.
- **Our workaround:** renew with one `executeBatch` holding `patches: [{ entityKey, set }]` and `extensions: [...]`, which also makes it one transaction instead of two.

### 8. The entity-events contract address is not exported

- **What we tried:** finding out whether an expired entity had been deleted first, by asking `getLogs` for `EntityDeleted` on that key (see #2).
- **What happened:** the SDK exports `ENTITY_EVENTS_ABI`, but not the address the events come from (`0x4400000000000000000000000000000000000044`). It exists inside the SDK as `ARKIV_ADDRESS` but is not exported.
- **What we expected:** an exported constant next to the ABI, or a `getEntityHistory(key)` helper.
- **Why it matters:** anyone who needs history for one key (audit trails, "was this deleted or did it expire?") has to hard-code an address that could change between networks.
- **Reproduce:** the SDK has `ARKIV_ADDRESS` internally (`dist/expiry-*.js`), but it is missing from the export list at the end of `dist/index.js`; print `log.address` from any event in `spike/02-replay-events.ts` to see it.
- **Our workaround:** a constant in `src/worker.ts`, with a comment.

### 9. `executeBatch` does not say whether `createdEntities` follows the order of `creates`

- **What we tried:** batching everything a worker writes (claims, receipts, its heartbeat) into one `executeBatch` per transaction, so a wallet is not limited to one write every ~2 blocks, and mapping each new key back to its write by index.
- **What happened:** it works: five creates sent as `zz, aa, mm, bb, yy` came back in that order. But neither the typings nor the docs say so, and keys are random, so the only way to know was to test it.
- **What we expected:** a documented guarantee (or a `createdEntities` that pairs each key with its index).
- **Why it matters:** batching is the main lever for write throughput from one wallet. Before batching, our two-worker test fired 100 rules a median 19 blocks late; with it, all 100 fired within 3 blocks (median 1).
- **Reproduce:** `npx tsx spike/05-batch-order.ts`.
- **Our workaround:** rely on the observed order, and keep a test that checks it.

### 10. A rate-limited query hangs through the SDK instead of failing

- **What we tried:** running the worker in Docker without `ARKIV_ACCESS_KEY` on 17 Oct, after a day of test runs from the same IP.
- **What happened:** `eth_blockNumber` and `eth_getBalance` answered in under 2 s, but the first `arkiv_query` never returned: the worker printed nothing for 2+ minutes and its health check went unhealthy. A raw call to the same method returned `HTTP 429 {"error":"ANON_COST_LIMITED","message":"unauthenticated query budget exhausted; get an API key at https://hub.arkiv.network…"}`. Through the SDK there is no error at all: viem's HTTP transport honours `Retry-After` on a 429 and waits it out, even with `timeout: 20_000` set on the transport.
- **What we expected:** a typed error from the SDK (for example `RateLimitedError` with the reset time), so callers can say "set an access key" instead of appearing frozen.
- **Why it matters:** a public worker, or a dashboard on the anonymous browser quota (#4), looks dead with no clue why. The budget is cost-based (`Arkiv-Cost: 100` per query here), separate from the `RateLimit: limit=600` header, and its window is not documented.
- **Reproduce:** exhaust the anonymous budget (run the live suites without `ARKIV_ACCESS_KEY` a few times), then run any `select(...)` query; compare with a raw `fetch` of `arkiv_query`, which shows the 429.
- **Our workaround:** every query in this package fails after 30 s with `QueryTimeoutError` naming the access key (`src/query.ts`); the CLI warns at startup when no access key is set. The dashboard, which cannot hold a key, builds its client with `http(url, { retryCount: 0 })`: then the same 429 surfaces in about 1.5 s as `HttpRequestError` with `details: "ANON_COST_LIMITED"`, and the page shows a "reads are being limited" banner and retries on its own schedule.
- **Also seen in the browser (18 Oct):** a day of building and screenshotting the dashboard from one IP was enough to exhaust the anonymous budget; one page load costs about 12 calls (5 `arkiv_query`), so a normal visitor is far from it.

### 11. The WebSocket closes every minute or so, and viem's default reconnect can snowball

- **What we tried:** the worker in Docker (`docker/worker.Dockerfile`), following `watchEntityEvents` over `wss://rpc.tiramisu.db-chain.testnet.arkiv.network` for 5 minutes on 17 Oct.
- **What happened:** the server closed the socket three times in about 4.5 minutes (`The socket has been closed.`), with no close reason. Our first reconnect code called `connect()` from `onError`, and that went badly: viem calls `onError` once per failed request rather than once per outage, and after its 5 retries it keeps the dead socket cached under the URL, so each new subscription failed at once and spawned more. One drop grew to about 6,000 log lines a second within 90 seconds, and the feed never recovered. Rules still fired, because deadlines run on the worker's own loop.
- **What we expected:** a documented idle or keep-alive policy for the RPC's WebSocket, and an example in the SDK docs of a `watchEntityEvents` that survives a reconnect. The SDK's JSDoc example only logs `onError`.
- **Why it matters:** every long-lived watcher (worker, dashboard) has to reconnect several times an hour, and the obvious way to do it is the wrong one.
- **Reproduce:** follow `watchEntityEvents` for a few minutes and log `onError`; to see the storm, reconnect from inside `onError` with viem's default `webSocket(url)`.
- **Our workaround:** `src/feed.ts` uses `webSocket(url, { reconnect: false })`, lets only the current connection reconnect, once, with 1–10 s backoff, and closes the failed socket client, which evicts it from viem's cache. The unit test "a dropped event feed reconnects once per outage" fakes a socket that errors three times per subscription. Re-run in Docker: three drops gave exactly three reconnect lines.

### 12. An exhausted access key gives no reset time

- **What we tried:** the two-worker suite (`npm run test:live:network`) with `ARKIV_ACCESS_KEY` on 17 Oct, after a day of live test runs on the same key.
- **What happened:** every `arkiv_query` returned `HTTP 429 {"error":"QUOTA_EXCEEDED","message":"quota exhausted"}`, with `Arkiv-Quota-Used-Percent: 100`, but no `Retry-After` and no reset time. Unlike #10, this 429 does reach the SDK caller, as viem's `HttpRequestError` whose first line is only `HTTP request failed.` (the reason is in `details`, after the request body).
- **What we expected:** a reset time (a `Retry-After`, or a `RateLimit-Reset`), and a documented quota size and window per key. The only hint is in the anonymous 429's message ("get an API key at https://hub.arkiv.network for a monthly quota"), which suggests an exhausted key stays exhausted until the month turns.
- **Why it matters:** a public worker that shares a key with test runs stops working with no way to know when it comes back. It also shows that a production worker needs its own key.
- **Reproduce:** run the live suites on one key until queries fail, then `curl -D -` any `arkiv_query` with that key.
- **Our workaround:** worker logs now name the cause in one line ("Arkiv quota for this access key is used up…", `describeError` in `src/query.ts`), and the deployed public worker gets its own key.

## What went smoothly (tested the same way)

| Tested | Expected | Happened | Script |
|---|---|---|---|
| `lte`/`gte` ranges on our own `u64` attribute (`fireat`), not just `$expiresAt` | Range matches | Matches and excludes correctly, including a `gte`+`lte` window | `spike/01-u64-range.ts` |
| Attribute shape in query results | Typed values | Every attribute is `{ type, value }`, `u64` values are `bigint`, `str` values are strings | `spike/01-u64-range.ts` |
| Live `watchEntityEvents` over WebSocket with no `fromBlock` | Pushed events | A create arrives within a few seconds, no polling loop | `spike/02-replay-events.ts` |
| Replaying with `fromBlock` after downtime | Missed events replayed | The create and the delete that happened "while down" both replay, in order | `spike/02-replay-events.ts` |
| `executeBatch` patching and extending the same entity | One transaction | Works; the heartbeat renews in one tx | `spike/04-heartbeat-patch.ts` |
| `executeBatch` with two creates | One transaction | Both land in the same block, atomically | `spike/03-claim-race.ts` |
| `ExpirationTime.fromSeconds(60)` for a claim lease | About 30 blocks | Exactly 30 blocks at the 2 s block time | `spike/03-claim-race.ts` |
| Cost | Cheap | A create plus a delete cost 0.000135 GLM | `spike/01-u64-range.ts` |
| `getBlockTiming` as a date↔block clock | Current block and time | Within 1–2 s of the local clock, `blockDuration` 2 | `npm run test:live:sdk` |
| `str()` length guard | Over-long values refused | The SDK refuses a 129-byte `str` before sending, with a message pointing at the payload | `test/schema.test.ts` |
| `executeBatch` return value | The new keys | `createdEntities` lists them in batch order | `npm run test:live:sdk` |
