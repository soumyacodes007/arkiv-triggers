# AGENTS.md — Arkiv Triggers

Guidance for anyone (human or coding agent) working in this repo. Read the **Rules** section before writing code.

## Rules (non-negotiable)

- **No secrets or real personal data on Arkiv, ever — not even hashed.** This disqualifies the submission. Secrets live in Railway/Vercel env vars. A rule *names* a secret (e.g. `secret: "telegram"`); the worker looks it up in its own environment.
- **Demo data is synthetic.**
- **Pin `@arkiv-network/sdk@0.8.1`** and `viem` (peer dependency). Pass `select()` selections inline, or use `as const`, otherwise types are lost.
- **One wallet per worker, one write queue per wallet.** Parallel writes from one wallet collide on entity keys.
- **Log every Arkiv rough edge in `/arkiv/friction.md` the same day**, with steps to reproduce. It is a quarter of the score.
- **Code starts only after the challenge opens: 9 Oct 2026, 12:00 London (4:30 pm IST).** Everything must be original work from that point.
- **Never rewrite git history after submission.** Judges check the commit at the deadline.
- License is **MIT**.

## Problem

Arkiv data expires on its own, but nothing happens when it does. Every app that cares about expiry has to run its own private cron script, and Arkiv keeps no record of whether that script actually did its job.

We checked the official SDK (`@arkiv-network/sdk` 0.8.1). Its live events cover create, patch, expiry extended, ownership transferred and delete. There is **no expired event**, and the delete event only fires when an owner deletes before expiry. So expiry is silent.

What this looks like in real apps:

- A ticket app holds a seat for 60 seconds. When the hold expires, someone has to free the seat and tell the waitlist.
- Our India app (**Kendra Watch**) has stock reports that expire after 24 hours. Before that, someone has to ask the shop owner to confirm again.
- A team wants a chart of how many entities match a query over a week. Arkiv only answers "what matches right now", and past-block reads only work inside the node's retained range.

Who is harmed today:

- **Builders** rebuild the same polling script in every project. It runs on one private server. If that server stops, crashes or runs out of credit, actions silently stop.
- **End users** miss the alert, the freed seat or the reminder, and nobody can prove whether the action ran or was skipped.
- **The read side is empty.** The Arkiv Data Explorer runs one query once. There are no saved queries, no history, no charts, no alerts.

The Arkiv team lists both "Arkiv Triggers" and "Query-to-Dashboard Studio" under "Nobody built this yet" on the Arkiv Hub ecosystem page.

## Solution

Arkiv Triggers is an open worker network for Arkiv. A trigger rule is itself an Arkiv entity. Any worker can pick it up, watch the query, run the action when the condition is met, and write a signed receipt back to Arkiv. A dashboard shows the rules, every firing and charts built from the same workers.

> The Explorer answers a question once; Triggers keeps watching it and acts on it.

### Who uses it

- **Arkiv app builders (main user).** They add a trigger in about 5 lines instead of writing and hosting a cron script. First real user: the Kendra Watch team.
- **End users of those apps, indirectly.** They get the alert, and the receipt proves it was sent.
- **Anyone who wants to run a worker.** One command starts one, so no single company owns the automation.

### v1 scope

| Part | v1 scope |
|---|---|
| Conditions | Entity matching a query is about to expire (N blocks before) · entity has expired · count of a query crosses a number · new entity matches a query |
| Actions | Webhook with an HMAC signature · Telegram message · GitHub issue · Arkiv write (create a snapshot entity) |
| Proof | One signed receipt entity per firing, with status, block and response code, plus an optional ack entity written by the receiver (two ticks: sent, then confirmed) |
| Read side | Dashboard: rules, live firings, receipt viewer, worker status, charts from snapshots, embeddable panels, share links |
| Developer tools | npm package with a small SDK and CLI: create rule, list, verify receipt, worker start |

**Not in v1** (list as future work in the README): paying workers or staking, running user code inside workers, private or encrypted rules, mainnet.

## Product surfaces

| Surface | What it is | Who uses it | Where it lives |
|---|---|---|---|
| Worker | Node.js service that watches rules, fires actions, writes receipts | Us, and any builder who wants to run one | 3 services on Railway, plus `npx arkiv-triggers worker` anywhere |
| SDK + CLI | npm package: create rules, list them, verify a receipt, start a worker | App builders | npm, source on GitHub (MIT) |
| Dashboard | Next.js web app, reads Arkiv directly from the browser | Builders, judges, the Arkiv team | Vercel |
| Demo app | Small seat-hold page that creates expiring holds and receives the webhook | Demo video and testing | Vercel, same project as the dashboard |

### Dashboard pages

1. **Rules** — every active rule, its query, condition, action, owner and time left. Connect a wallet (MetaMask on Tiramisu) to create one.
2. **Live** — a feed of firings as receipts land, with worker address, block, latency and a second tick when the receiver acknowledges.
3. **Receipt** — one receipt, its signature checked in the browser, and an "Open in Data Explorer" link.
4. **Workers** — which workers are alive right now, from their heartbeat entities.
5. **Panels** — a chart per saved query, drawn from snapshot entities, with a share link and an `/embed/panel/[key]` route for iframes.

The dashboard uses the **same query syntax as the Data Explorer**, so a query tested there can be pasted straight in.

## Hosting

Workers on Railway, dashboard on Vercel, **no database**: all shared state lives on Arkiv. Both must stay up until **23 October**, when judging ends.

**Railway (workers).** Hobby plan is $5/month and includes $5 of usage. Three small Node services should fit.

- Three services: `worker-a`, `worker-b`, `worker-c`, built from one Dockerfile. Each has its own wallet, so receipts show three different signers.
- Restart policy: always. Each exposes `/healthz` returning the last processed block, so a stuck watcher is visible.
- No volume. On restart, a worker reads its own heartbeat entity to find the last block it processed and replays from there.

**Vercel (dashboard and demo app).** Next.js. Reads Arkiv straight from the browser with the public client — no API server. Wallet writes (creating a rule) also happen in the browser.

### Environment variables

| Variable | Where | Notes |
|---|---|---|
| `ARKIV_RPC_URL` | Railway, Vercel | `https://rpc.tiramisu.db-chain.testnet.arkiv.network` |
| `ARKIV_WS_URL` | Railway | `wss://rpc.tiramisu.db-chain.testnet.arkiv.network` |
| `ARKIV_ACCESS_KEY` | Railway | Project key from the Arkiv Hub for higher rate limits |
| `WORKER_PRIVATE_KEY` | Railway, one per service | Testnet wallet funded from the faucet |
| `WEBHOOK_SIGNING_SECRET` | Railway | Used for the HMAC header on webhooks |
| `TELEGRAM_BOT_TOKEN` | Railway | For Telegram actions |
| `GITHUB_TOKEN` | Railway | Fine-grained token, issues only, demo repo only |

For "anyone can run a worker", we publish the same Docker image and the npm command. An outside worker needs only an RPC URL and a funded testnet wallet; actions that need our secrets (Telegram, GitHub) are **skipped** by workers that do not have them.

## Architecture

Arkiv is the only shared state. Builders write data and rules to Arkiv, workers on Railway watch it and act, and the dashboard on Vercel reads it.

**Workers never talk to each other**; they coordinate only through claim and receipt entities on Arkiv.

### Entity types

All entities carry a `type` attribute.

| Type | Owner | Key attributes | Payload | Expiry |
|---|---|---|---|---|
| `trg.rule` | Rule creator | `ruleId`, `condition`, `action`, `queryHash`, `leadBlocks`, `threshold`, `active`, `ackFrom` | Query text, action config, secret name | Creator picks, default 7 days |
| `trg.claim` | Worker | `eventId`, `ruleId`, `worker` | None | 30 blocks (~1 min), acts as a lease |
| `trg.receipt` | Worker | `eventId`, `ruleId`, `status`, `firedAtBlock` | Action, response code, latency, request hash, signature | 30 days |
| `trg.ack` | Receiver (must match the rule's `ackFrom`) | `eventId`, `ruleId`, `status` | None | 30 days |
| `trg.snap` | Worker | `panelId`, `bucket`, `value` | None | 30 days |
| `trg.worker` | Worker | `version`, `lastBlock`, `actions` | None | 150 blocks (~5 min), extended every minute |
| `trg.panel` | Panel creator | `panelId`, `chart`, `queryHash` | Query text, title | 30 days |

The worker heartbeat is itself an expiring entity: if a worker dies, its heartbeat expires and it drops off the dashboard on its own.

### How one firing works

1. **Load rules.** Each worker queries `type = trg.rule` and `active = true`, then follows new and patched rules with `watchEntityEvents`.
2. **Schedule.** For an expiry rule, the worker runs the rule's query plus `$expiresAt <= head + leadBlocks` and adds each entity to a schedule keyed by its expiry block. `ExpiryExtended` moves it; `EntityDeleted` removes it.
3. **Name the event.** `eventId = keccak256(ruleId, entityKey, expiresAt)`. Every worker computes the same id for the same event.
4. **Claim.** When the block arrives, the worker confirms the entity is gone with `getEntity`, checks for an existing receipt or live claim, and if there is none writes a `trg.claim`. One block later it reads all claims for that `eventId`; **the earliest by block and log index wins** and the rest back off.
5. **Act.** The winner runs the action. Webhooks carry the `eventId` as an idempotency key plus an HMAC signature header.
6. **Receipt.** The winner signs the receipt fields (EIP-191) with its wallet and writes a `trg.receipt`. If it dies first, its claim expires after 30 blocks and another worker takes over.

### Acknowledgment (optional)

If the rule sets `ackFrom`, the receiver calls `ack(eventId)` from our SDK after handling the webhook. That writes a `trg.ack` entity from the receiver's own wallet. Arkiv records who created every entity, so the ack proves who confirmed delivery; **an ack from any other wallet is ignored**.

If no valid ack arrives within **15 blocks (~30 s)**, workers treat that as a new trigger: retry the webhook **up to 3 times**, then mark the receipt `undelivered`. Triggers watches its own deliveries.

Actions we cannot ack on Arkiv get the best proof available: a GitHub action stores the issue URL in the receipt, which anyone can open. A Telegram action stores the message id, which cannot be checked publicly; we say that plainly.

**Delivery is at least once.** Because the `eventId` travels with every action, receivers can drop repeats. Phase 3 measures how often a repeat happens.

### Snapshots for charts

Every 15 blocks (~30 s) per panel, one worker claims that panel and time bucket, counts the matching keys page by page, and writes a `trg.snap`. The dashboard only reads snapshots, so charts load fast and no indexer is needed.

## Repo layout

One TypeScript monorepo on **Node 22** with `@arkiv-network/sdk` 0.8.1 and `viem`:

```
packages/sdk        rule builder, receipt verifier, CLI
packages/worker     watcher, scheduler, claim, actions, receipts, snapshots
apps/dashboard      Next.js dashboard and the seat-hold demo
arkiv/schema.md     entity types, attributes, expiry per type, queries
arkiv/friction.md   reproducible feedback on Arkiv rough edges
```

## Arkiv gotchas

The biggest one: **Arkiv emits no event when an entity expires**, so the worker has to schedule expiries itself from each entity's expiry block. Everything below comes from reading the 0.8.1 SDK typings and one live call to Tiramisu on 7 Oct 2026, which reported a **2 second block time**.

| Gotcha | Why it matters | What we do |
|---|---|---|
| No expired event. `EntityDeleted` only means "deleted by its owner before expiry" | We cannot subscribe to expiry | Query `$expiresAt` for each rule, keep a schedule keyed by block, confirm with `getEntity` once the block passes |
| Expiry is a block number, not a timestamp. A duration like `fromDays(30)` is resolved against the block the tx lands in, so the returned `expiresAt` is a lower bound | Timing can be off by a few blocks | Read the real `expiresAt` from the chain after create. Convert blocks to time with `getBlockTiming` |
| `extendEntity` sets a new expiry counted from now; it does not add time. A change that would not move expiry later is rejected | Renewals can fail in surprising ways | Compute the target expiry, treat "not later" as a no-op, not an error |
| Only the owner can patch or extend, unless created with `permissionlessExtension`. Flags are fixed at creation | Workers cannot renew other people's entities | The "auto-renew" recipe tells builders to create entities with that flag |
| `EntityPatched` says that something changed, not what | Must re-read the entity | Re-fetch on every patch event before re-checking the rule |
| Query pages max out at 200. Cursor is tied to query, block and selection. `orderBy` is deprecated and has no effect. There is no count | Counting and sorting are on us | Count by paging keys only (`select({ key: true })`), sort in JS, store counts as snapshot entities |
| `atBlock` reads only work within the node's retained range | No long history from the chain | History comes from our own snapshot entities |
| A watcher whose filter the node dropped just goes quiet. Errors default to `console.error` | A dead watcher looks like a quiet chain | Pass `onError`, reconnect, check that the last processed block keeps moving, replay with `fromBlock` |
| Limits: 32 attributes, 32-byte attribute names, 128-byte string values, 128 KB payload | A full query will not fit in an attribute | Query text goes in the payload; a short `queryHash` goes in an attribute |
| Keys use a random salt by default. `predictEntityKeys` is only valid while nothing else from that owner is in flight | Parallel writes from one wallet collide | One wallet per worker and a single write queue per wallet |
| Public RPC is rate limited. Access keys give higher limits | Three workers polling every block adds up | Register a project key on the Hub; dashboard reads snapshots, not raw scans |
| Rules require SDK 0.8.x. `viem` is a peer dependency. A `select()` stored in a variable loses its types unless it is `as const` | Build or type errors | Pin `@arkiv-network/sdk@0.8.1` and `viem`; pass selections inline |
| No secrets or real personal data on Arkiv, even hashed | Disqualification | Secrets in Railway env; rules name secrets, never hold them; demo data is synthetic |

## Build plan

Six phases, 9–18 October. **Each phase ends with a test that must pass before the next starts.**

### Phase 0 · 8 Oct · Setup, no code

Build:
- Railway and Vercel accounts, Arkiv Hub access key, 4 testnet wallets funded (3 workers, 1 demo).
- Final entity schema from the Architecture section, agreed by the team.
- Team split: 2 people on Triggers, the rest on Kendra Watch.

Test: every account works and every wallet has testnet funds.

### Phase 1 · 9 Oct · Spike and first working trigger

Build:
- 2-hour spike on Tiramisu: create, patch, extend, delete, `watchEntityEvents`, a `$expiresAt` query, a 500-entity paged query, `executeBatch`.
- One worker, one rule from a config file: "when an entity matching this query expires, call this webhook", then write a receipt.
- Repo with MIT license, first X post with a 30-second clip.

Test: create 20 entities expiring in 30–90 s. Pass if 20 webhooks arrive, 20 receipts exist on Arkiv, and each fires within 3 blocks (~6 s) of expiry.

### Phase 2 · 10–11 Oct · Rules on Arkiv, more actions

Build:
- Rules stored as `trg.rule` entities; workers load and follow them live.
- SDK and CLI: create, list, verify.
- Actions: signed webhook, Telegram, GitHub issue. Conditions: expiring soon, expired, count above, new match.
- Reschedule on `ExpiryExtended`, cancel on `EntityDeleted`.

Test:
- Extend an entity before it expires. Pass if nothing fires at the old block and it fires at the new one.
- Delete an entity early. Pass if nothing fires.
- A rule with a bad query. Pass if the worker writes a failed receipt and keeps running.

### Phase 3 · 12–13 Oct · Network, dedup, recovery

Build:
- Three workers on Railway with the claim and lease protocol.
- Worker heartbeat entities and replay from the last processed block.
- Receiver acknowledgments: `ack(eventId)` in the SDK, `trg.ack` entities, retry up to 3 times when no ack arrives within 15 blocks, and two ticks on each receipt.
- Publish v0.1.0 on npm, post the 5-line example in the Arkiv Discord, **freeze the API** for the Kendra Watch team.

Test:
- 3 workers, 500 expiries over 20 minutes. Pass if there are exactly 500 receipts and 0 duplicates.
- Kill a worker right after it claims. Pass if another worker fires once the lease expires.
- Stop a worker for 5 minutes and restart it. Pass if no events from that window are missed.
- Turn off acks in the demo receiver. Pass if the webhook is retried 3 times and the receipt ends as `undelivered`. Then send an ack from a different wallet. Pass if it is ignored.

### Phase 4 · 14–15 Oct · Dashboard

Build: the five dashboard pages on Vercel, snapshot rules, embeddable panels, share links, "Open in Data Explorer".

Test:
- A panel's latest value matches a manual count of the same query in the Data Explorer.
- An embedded panel loads inside another page.
- Every page works at phone width.
- The receipt page marks a tampered receipt as invalid.

### Phase 5 · 16–17 Oct · Real users and docs

Build:
- Kendra Watch running on Triggers (stock report reminders, challenge window closing, back-in-stock alerts).
- Seat-hold demo app.
- README, 3 recipes, `schema.md`, `friction.md`.

Test: a teammate who did not build Triggers clones the repo and gets a working trigger in under 10 minutes using only the README.

### Phase 6 · 18 Oct · Submit

Build: demo video under 3 minutes, Devfolio form, final deploy.

Test: open the live links in a private window with no wallet; the dashboard loads and the demo works.

**Deadline: 23:59 London on 18 Oct = 4:29 am IST on 19 Oct. Aim to submit by 10 pm IST on 18 Oct.**

## Submission, risks and success

We win if judges see a trigger network that works, that other teams actually use, and that is honest about Arkiv's rough edges. Tracks: **Open Source** first, **Censorship Resistance** second, each with its own "who is harmed" answer.

### Submission gates (from the official rules)

- [ ] Public deployment on Tiramisu, usable without asking for access
- [ ] Reproducible steps plus the exact query behind each claim
- [ ] Public repo, MIT license, setup in the README
- [ ] `/arkiv/schema.md`: entity types, attributes, expiry per type, queries
- [ ] On-chain evidence: the 3 worker wallets and the demo wallet
- [ ] `/arkiv/friction.md` with specific, reproducible feedback
- [ ] Demo video under 3 minutes
- [ ] Tracks picked on Devfolio and every required question answered
- [ ] README links Kendra Watch as a user, and Kendra Watch discloses that it builds on Triggers

### Risks

| Risk | Fallback |
|---|---|
| Several other teams build Triggers | Ship and announce by 13 Oct; win on real multi-worker dedup, rules on Arkiv and outside users |
| Tiramisu slow or down on demo day | Record the video early; replay from the last block after outages; note downtime in `friction.md` |
| Rate limits from 3 workers polling | Access key, poll every 2 blocks instead of 1, dashboard reads snapshots |
| Scope creep on the dashboard | Charts are line and bar only; no editor beyond a query box |
| Team split slows Kendra Watch | API frozen on 13 Oct; Kendra Watch uses a stub until then |

### Success targets by 18 October

- 0 duplicate firings across 3 workers in the 500-expiry test
- 95% of firings within 3 blocks of the condition, and every webhook to our own receivers acknowledged within 15 blocks
- At least 2 real consumers: Kendra Watch and our own snapshots; stretch goal: 1 outside team
- A new user gets a working trigger in under 10 minutes from the README
