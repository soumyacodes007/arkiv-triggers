# Hand-off: arkiv-triggers (17 Oct 2026)

What this repo is, what works, how it was proven, and what is left. The spec is [PRD.md](PRD.md);
working rules are in [AGENTS.md](AGENTS.md). This is repo 1 of 2: the npm package (SDK + worker +
CLI) and the Docker image. The dashboard is a separate repo and is not started here.

## State in one table

| Area | State |
|---|---|
| SDK (`createTriggers`, rules, receipts, workers, `watch`, `sealForWorker`, `verifyWebhook`, `toBlock`/`toDate`) | Done, tested live |
| Worker (`startWorker`): expire and block triggers, claims, receipts, heartbeat, restart resume, `any`/`own` modes | Done, tested live with one and two workers |
| Actions: receipt, signed webhook, extend, Telegram | Done, all four tested live (Telegram sent a real message) |
| CLI (`npx arkiv-triggers`, `new-key`, `/healthz`) | Done, run live |
| Docker image | Rebuilt with every change below and run in the WSL Docker with production settings: healthy in about 10 s, fires an assigned rule 0–1 blocks late, resumes from its saved block, exits 0 on SIGTERM |
| Docs: README, `arkiv/schema.md`, `arkiv/friction.md` (12 entries), spikes | Done |
| GitHub | Pushed to https://github.com/soumyacodes007/arkiv-triggers (`main`, first commit `262efab`, 18 Oct) |
| npm publish, Railway deploy | **Not done.** Each needs the owner's go-ahead |

## Evidence (all on Tiramisu, 17 Oct 2026)

| Command | Result |
|---|---|
| `npm test` | 25/25 unit tests (local, no network), including a query that never answers, a feed that keeps erroring, and rate-limit log lines |
| `npm run test:live:sdk` | 7/7: create, batch create, list, audit trail, refuse missing target, delete, `watch` over WebSocket |
| `npm run test:live:worker` | 13/13: expire→receipt (0 blocks late), block→signed webhook (verified), deleted target→`skipped`, extend (+1 day), heartbeat online |
| `npm run test:live:network` | 21/21 with workers a and b: crash takeover (no one fires while a lease is live), downtime catch-up, 20-rule race with 0 duplicates, median 0–1 blocks late |
| `NET_RULES=100 npm run test:live:network` | 100/100 fired, 0 duplicates, 100% within 3 blocks (median 1) |
| `npm run test:live:telegram` | 6/6: chat stored only sealed, one real message sent, receipt holds Telegram's message ID, 1 block late |
| `npm run test:live:deployed` (new) | 4/4 against the Docker container (worker-b): heartbeat online, one `ok` receipt for an assigned rule, signed by the container's wallet, 0 blocks late. Set `DEPLOYED_WORKER=0x…` to check the Railway worker the same way |

**Re-run after the 17 Oct evening fixes (query timeout, event feed, error logs):** unit 25/25, `test:live:sdk` 7/7,
`test:live:worker` 13/13, `test:live:deployed` 4/4, `test:live:telegram` 6/6 (a real message, ID 4, 1 block late;
run on the anonymous budget with `ARKIV_ACCESS_KEY=` because the key's quota had run out, `429 QUOTA_EXCEEDED`,
friction #12). `test:live:network` (two workers) was not re-run, by the owner's choice; the changes don't touch
claims or firing.

Each live suite takes 3–8 minutes and spends a little test GLM (a create + delete is about 0.000135 GLM).

## Repo map

```
src/schema.ts        entity formats (rule, claim, receipt, heartbeat), validation, action menu, templates
src/sdk.ts           createTriggers: everything apps and the dashboard call
src/worker.ts        startWorker: the engine (see "How the worker fires a rule")
src/actions/         receipt, webhook (SSRF guard, signed, 30 s budget), telegram (sealed chat, 30 s budget), extend
src/feed.ts          the self-healing event feed (one reconnect per drop) for the worker and watch()
src/query.ts         paged queries with a 30 s timeout; describeError for one-line logs
src/seal.ts          X25519 + XChaCha20-Poly1305 sealing of chat IDs to one worker
src/webhook.ts       verifyWebhook for receivers
src/cli.ts           the worker as a command; PORT enables /healthz
docker/              worker.Dockerfile
arkiv/schema.md      every entity type, attribute, lifetime and query
arkiv/friction.md    Arkiv rough edges, each with a reproduction
spike/               one-question scripts behind each design decision
test/                unit tests; test/live/ for the Tiramisu suites
```

## How the worker fires a rule

1. **Load rules** (`type = trg.rule`) every ~60 s, or sooner when the WebSocket feed shows any change.
   Expiry emits no event, so deadlines are checked on the worker's own 4 s loop.
2. **Claim early.** Rules due within 8 blocks are claimed (`trg.claim`, 60 s lease) before their
   deadline. The worker re-reads claims until its own are visible (reads lag writes, friction #5);
   the earliest `$createdAt` wins, ties broken by the lowest key.
3. **Fire at the deadline block.** Confirm first: an expire rule's target may have been extended
   (then wait) or deleted (then a `skipped` receipt, found from `EntityDeleted` logs). Act only with
   ≥ 18 blocks of lease left; a worker extends its own claim if it is short.
4. **Receipt** (`trg.receipt`, 30 days), signed by the worker as `$creator`.
5. **One writer per wallet, with group commit.** Everything a worker writes (claims, receipts,
   extensions, heartbeat) is queued and sent as one `executeBatch` per transaction, receipts first.
   This is what took 100 rules from a median 19 blocks late to 1.

Delivery is exactly once in every test run; in the worst case (a receipt delayed past its lease) it
is at least once, which is why webhooks carry a stable `x-trg-event` ID.

## Decisions that differ from, or add to, the PRD

| Decision | Why |
|---|---|
| `npx arkiv-triggers` instead of `npx arkiv-triggers-worker` (the latter still works once installed) | With no install, npx looks for a package named after the command |
| `fireAt` is stored as `fireat` | The node rejects uppercase attribute names |
| Claims are taken 8 blocks early; act needs ≥ 18 blocks of lease | Found by the two-worker tests: claiming at the deadline made firing 30+ blocks late, and a short lease caused one duplicate |
| Webhook and Telegram actions: 30 s total budget, 10 s per attempt | Must finish inside the lease, or another worker may fire again |
| Telegram rules should name their worker (the README example and the live test do; not enforced) | The chat ID is sealed to one worker's key, so only that worker can open it; a rule left as `any` is still sent only by a worker with a bot token, and fails if that worker cannot open the seal |

## Wallets and secrets

- Addresses: [wallets.md](wallets.md). Keys: `.env.local` only (gitignored, never printed or committed).
- Funded: worker-a `0x1c92…C9b6` (~2.98 GLM), worker-b `0xf856…07Db` (~10 GLM). Unfunded: worker-c, demo.
- `.env.local` also holds `TELEGRAM_BOT_TOKEN` (bot `@arku678_bot`), `TELEGRAM_CHAT_ID`,
  `ARKIV_ACCESS_KEY`, `GITHUB_TOKEN`, `WEBHOOK_SIGNING_SECRET`.
- On Arkiv there are no secrets and no personal data: rules are public, chat IDs are only stored sealed.

## What is left, in order

1. **npm** (needs the go-ahead): bump `version` to `0.1.0`, `npm run build`, read `npm pack --dry-run`
   (only `dist`, `README.md`, `LICENSE`, `package.json`), `npm publish`.
2. **Railway public worker** (needs the go-ahead): deploy `docker/worker.Dockerfile`; set
   `WORKER_KEY` (a dedicated funded wallet), `TG_TOKEN`, and **`ARKIV_ACCESS_KEY` (required, and a key of its
   own, not the one the live tests use)**; health check path `/healthz` (Railway sets `PORT`). Without a key the
   worker runs on the anonymous budget, which a day of traffic used up (friction #10); a key shared with test runs
   also runs out (#12). Check it with `DEPLOYED_WORKER=0x… npm run test:live:deployed`, then put its address in
   the README and `arkiv/schema.md`.
3. **Dashboard repo** (owner sets it up): it installs `arkiv-triggers` from npm, so step 1 comes first.

## Known limits (honest list)

- **The Tiramisu WebSocket drops about once a minute** (friction #11). The worker and `watch()` reconnect
  once per drop (`src/feed.ts`); missed events are covered by the worker's 60 s rule reload and the SDK's
  re-snapshot on reconnect.
- **Keeping the WSL Docker up:** WSL shuts its VM down a few seconds after the last `wsl` command exits, which
  stops containers (they get SIGTERM). For a long local run, keep a WSL session open.

- **Load sharing is first-come.** Whoever claims first fires; in one run worker-b fired all 20
  race rules. Correct, but not balanced. Rendezvous hashing over live heartbeats would spread it.
- **Rule reloads follow any chain event.** The event feed cannot be filtered (friction #6), so on a
  busy chain a worker reloads rules about every tick. Fine on testnet; worth a rate limit later.
- **Rules stay loaded until they expire** (deadline + 7 days). Fired ones are skipped in memory, but
  each reload still reads them.
- **A target already gone when a worker first sees it** gets "now" as its deadline, so two workers
  can compute different event IDs for that one rule. The claim protocol still fires it once.
- **The `/start` linking reply** sends the user their own chat ID in Telegram; the dashboard must seal
  it with `sealForWorker` before it goes into a rule.
- **Only two funded worker wallets**, so the three-worker setup from the old plan was not tested.
- Poora Mila (`../poora-mila`, paused) has the same `patchEntity({ attributes })` bug fixed here
  (friction #7); not touched, by request.
