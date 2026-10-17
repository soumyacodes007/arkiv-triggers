# AGENTS.md: arkiv-triggers

Guidance for anyone (human or coding agent) working in this repo.

- **The spec is [PRD.md](PRD.md).** Read it first. This file only adds working rules and the build order.
- This repo is **repo 1** from the PRD: the npm package (SDK + worker + CLI), the Docker image, and
  `arkiv/schema.md` + `arkiv/friction.md`. The dashboard is a separate repo, `arkiv-triggers-dashboard`;
  do not build it here.
- The previous hackathon-era plan (8 Oct 2026) is kept for reference in
  [docs/archive/hackathon-plan-2026-10-08.md](docs/archive/hackathon-plan-2026-10-08.md). Where it
  disagrees with the PRD, the PRD wins.
- **Status note:** the PRD says "the trigger engine and the worker are already built". As of
  17 Oct 2026 no engine code existed in this repo, on npm, on GitHub or on Tiramisu, so it is being
  built here, phase by phase, below.

## Rules

- **Never put secrets or personal data on Arkiv**, in plain text or hashed. Rules are public. A Telegram
  chat ID is only ever stored encrypted to a worker's key. Bot tokens and worker keys live in env only.
- **Rules never contain code.** Workers run only actions from the fixed menu (`telegram`, `webhook`,
  `receipt`, `extend`). `onFire` is for a self-hoster's own worker, never driven by rule content.
- **Pin `@arkiv-network/sdk@0.8.1`**; `viem` is a peer dependency.
- **Attribute names are lowercase** (`fireat`, not `fireAt`): the node rejects uppercase even though the
  SDK accepts it (see friction). Compared numbers are `u64(...)`, never bare numbers (a bare number is
  an `i32`, and a `u64` range over it silently matches nothing).
- **One write queue per wallet.** Parallel writes from one wallet collide on nonces and predicted keys.
- **Arkiv emits no expiry event.** The worker schedules deadlines itself and confirms with `getEntity`.
- **Expiry hides an entity from queries; it does not erase it.** History stays in transaction data.
- **Log every Arkiv rough edge in `arkiv/friction.md` the same day**, with versions and steps to reproduce.
- **Ask before outward actions:** publishing to npm, deploying to Railway, pushing to GitHub, or sending
  a real Telegram message.
- License is MIT.

## Build phases

Each phase ends with a test that must pass before the next starts.

| Phase | Build | Done when |
|---|---|---|
| 0. Scaffold | `package.json` (tsup, `.` and `./worker` exports, `arkiv-triggers-worker` bin, `files: ["dist"]`), tsconfig, src layout from the PRD, LICENSE, `.env.example`, README stub | `npm run build` and `npm run typecheck` pass |
| 1. Spikes | Answer the PRD's open questions on Tiramisu: u64 `lte` on own attributes, attribute shape in results, browser/CORS access to the RPC, claim race between two workers, replaying deletes with `fromBlock`, Telegram bot reachability | Each answer recorded in `arkiv/friction.md` with a script in `spike/` |
| 2. Schema | `src/schema.ts`: rule, claim, receipt, heartbeat formats, attribute builders and parsers, version `v`; action definitions and templates | Unit tests round-trip every entity type |
| 3. SDK | `createTriggers`, `createRule(s)`, `deleteRule`, `listRules`, `getRule`, `listReceipts`, `watch`, `listWorkers`, `sealForWorker`, `verifyWebhook`, `toBlock`/`toDate` | Live test on Tiramisu: create, list and delete a rule; watch sees it |
| 4. Worker | `startWorker`: load and follow rules, schedule `expire` and `block` triggers, confirm at the deadline, 60 s claims with oldest-wins, actions (receipt, signed webhook, extend, Telegram), receipts, heartbeat (5 min, extended every minute), replay from the last block, `any`/`own` modes | End-to-end on Tiramisu: a rule on an entity expiring in about 2 minutes fires once, writes one receipt, and a second worker does not double-fire |
| 5. Ship | `cli.ts` (`npx arkiv-triggers`; `arkiv-triggers-worker` once installed), Docker image, README quickstart, `arkiv/schema.md`, `arkiv/friction.md` complete | `npm pack --dry-run` lists only `dist`, README quickstart works from a clean checkout |

### Status (17 Oct 2026, end of day)

Full hand-off, with how to run everything: [HANDOFF.md](HANDOFF.md).

| Phase | State | Evidence (all on Tiramisu unless noted) |
|---|---|---|
| 0–3 | Done | `npm test` 25/25 (local); `npm run test:live:sdk` 7/7 |
| 4 | Done | `npm run test:live:worker` 13/13 (expire→receipt 0 blocks late, block→signed webhook, deleted target→`skipped`, extend); `npm run test:live:network` 21/21 with two workers (a, b); `NET_RULES=100 npm run test:live:network`: 100/100 fired, 0 duplicates, 100% within 3 blocks (median 1); `npm run test:live:telegram` 6/6 (real message sent, chat stored only sealed, receipt holds the message ID, 1 block late) |
| 5 | Done locally | CLI (`new-key`, `/healthz`, signal handling, unfunded-wallet check) run live; Docker image rebuilt and checked live (`npm run test:live:deployed` 4/4 against the container); `npm pack --dry-run` lists only `dist`; `npx arkiv-triggers` runs from the packed tarball |
| Ship | GitHub done; **npm and Railway need the go-ahead** | Pushed to github.com/soumyacodes007/arkiv-triggers (18 Oct); npm publish and the Railway public worker are pending |

What the two-worker tests changed in the worker (details in HANDOFF.md): claims are written 8 blocks
before a deadline; a worker acts only with ≥ 18 blocks of lease left (extending its own claim if
needed); every write goes through one group-commit writer (one `executeBatch` per transaction,
receipts first); webhook and Telegram actions have a 30 s budget.

`npx arkiv-triggers-worker` (the PRD's name) only works once the package is installed: with no install,
npx looks for a package of that name. The bin named after the package, `npx arkiv-triggers`, works
everywhere, so the docs use it.

## Phase 1 findings (17 Oct 2026) and the design decisions they force

Details and reproduction scripts are in [arkiv/friction.md](arkiv/friction.md).

| Open question (PRD) | Answer | Decision |
|---|---|---|
| `lte` on our own `u64` attributes? | Works, including `gte`+`lte` windows. A bare number is an `i32` and silently matches nothing | Range-query `fireat` directly; every compared number goes through `u64(...)` |
| Attribute shape in results? | `{ type, value }`; `u64` values are `bigint` | Parsers read `.value` and convert explicitly |
| Browser access to the RPC? | CORS is `*` and allows `X-Api-Key`; quota headers are exposed. A key cannot ship to browsers | The dashboard reads directly on the anonymous quota: snapshot once, then WebSocket |
| Two workers racing? | Same-block claims share `$createdAt`; no tx/log index is selectable | Winner = earliest `$createdAt`, then lowest entity key. Two-wallet test still pending (needs funded `worker-b`) |
| Deletes replayed after restart? | Yes with `fromBlock`. Expiry emits nothing, and `getEntity` throws `NoEntityFoundError` for both expired and deleted | The worker records deletes from events and saves its last block in its heartbeat |
| Telegram bot? | Token valid (`@arku678_bot`, read-only `getMe`) | The "tap Start, get your code" flow is built in phase 4; sending real messages needs the user's go-ahead |

**Attribute names must be lowercase**, so the PRD's `fireAt` is stored as `fireat` (the node rejects
uppercase names; logged in Arkognito's friction report and confirmed in this repo's schema tests).

## Wallets

Testnet wallets from 8 Oct are in `wallets.md` (addresses) and `.env.local` (keys, never committed).
`worker-a` (~2.98 GLM, also used by Poora Mila's registrar) and `worker-b` (~10 GLM) are funded;
`worker-c` and `demo` have none. The live tests use a and b.
