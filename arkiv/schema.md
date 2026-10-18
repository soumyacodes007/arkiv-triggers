# Arkiv schema

Everything OpenTrigger stores on Arkiv (Tiramisu testnet, chain 7738577), written with
`@arkiv-network/sdk` 0.8.1. The source of truth is [`src/schema.ts`](../src/schema.ts); this page
describes it.

Rules of the format:

- **Searchable fields are attributes; everything else goes in a JSON payload.** Attribute names are
  lowercase (the node rejects uppercase), so the PRD's `fireAt` is stored as `fireat`.
- **Every number a query compares is a `u64`.** A bare number is an `i32` and silently never
  matches a `u64` range ([friction #1](friction.md)).
- **Addresses and keys in attributes are lowercase hex strings**, so `eq` matches regardless of how
  the caller wrote them.
- **Every entity carries `type` and `v`** (schema version, `i32`, currently `1`). Readers ignore
  rules of an unknown version.
- **No secrets and no personal data, plain or hashed.** Rules are public. A Telegram chat ID is
  only ever stored sealed to one worker's key (`sealed:v1:…`, X25519 + XChaCha20-Poly1305). Bot
  tokens and worker keys live only in the worker's environment.
- **Who wrote it is Arkiv's own `$creator`**, never an attribute we set. A receipt's worker is its
  `$creator`, so it cannot be faked.

## Entity types

| `type` | Written by | Lifetime | What it is |
|---|---|---|---|
| `trg.rule` | The app or person (their own wallet) | Until its deadline + 7 days, at least 1 day | WHEN something happens, THEN which action |
| `trg.claim` | A worker | 60 s (30 blocks) | A lease: "I am firing this rule now" |
| `trg.receipt` | A worker | 30 days | What happened when the rule fired, signed by the worker's wallet as `$creator` |
| `trg.worker` | A worker | 5 min, renewed every minute | Heartbeat: the worker is alive, how far it has got, its sealing key |

Block time is 2 s. Lifetimes are set with `ExpirationTime`, so they are counted in blocks from the
block the write lands in.

### `trg.rule`

| Attribute | Type | Example | Notes |
|---|---|---|---|
| `type` | str | `trg.rule` | |
| `v` | i32 | `1` | |
| `app` | str | `arkiv-triggers` | Lets an app find only its own rules. Default `arkiv-triggers` |
| `on` | str | `expire` or `block` | The trigger |
| `target` | str | `0x9f3c…` (64 hex) | `on = expire` only: the entity whose expiry fires the rule |
| `fireat` | u64 | `690000` | `on = block` only: the block that fires the rule |
| `offset` | u64 | `30` | Fire this many blocks early. `0` = exactly at the deadline |
| `action` | str | `telegram`, `webhook`, `receipt`, `extend` | From the fixed menu; rules never contain code |
| `worker` | str | `any` or `0x7f3…` | Any public worker, or only this worker |
| `repeat` | str | `once` | Only `once` in v1 |

Payload (`application/json`):

```json
{
  "name": "Lease ends",
  "message": "{rule}: {entity} expired at {time}",
  "chat": "sealed:v1:…",
  "url": "https://example.com/hook",
  "extendDays": 30,
  "retries": 3
}
```

`message` placeholders `{entity}`, `{time}` and `{rule}` are filled in by the worker. `chat` is a
Telegram chat ID sealed with `sealForWorker`; a plain chat ID is refused by `validateRule`. `url` is
public, so it must not contain a secret (`ruleWarnings` flags URLs that look like one).

**Deadline.** `on = block`: `fireat - offset`. `on = expire`: the target's current `$expiresAt -
offset`, read when the worker checks it, so extending the target moves the deadline with it.

**Lifetime.** `ExpirationTime.atBlock(deadline + 7 days, { atLeast: 1 day })`. A rule cleans itself up
a week after it was due, which leaves time to read its receipts next to it.

### `trg.claim`

| Attribute | Type | Notes |
|---|---|---|
| `type` | str | `trg.claim` |
| `v` | i32 | `1` |
| `rule` | str | The rule's entity key |
| `worker` | str | The claiming worker's address (also its `$creator`) |
| `deadline` | u64 | The deadline being claimed |

No payload. **Who wins:** a worker writes the claims for every rule coming due in one batched
transaction (with whatever else it is writing), then re-reads live claims until its own are visible (a rival claim from the same or
an earlier block is then visible too). The earliest `$createdAt` wins, ties broken by the lowest
entity key. Queries expose no transaction or log index, so this is the order every worker can agree
on from the same query ([friction #3](friction.md)).

**Leases:** workers claim 8 blocks before a deadline, so the claim is settled when the block
arrives. A worker acts only while at least 18 blocks (36 s) of its lease remain, extending its own
claim first if needed, and every action has a time budget inside that (webhooks: 30 s for all
attempts), so its receipt lands before anyone else may take over. A worker that crashes holding a
claim loses it when the lease lapses after 30 blocks; if it restarts while the lease is still live,
it resumes the work itself.
Delivery is at least once in the worst case (a receipt write delayed past the lease), which is why
webhooks carry a stable `x-trg-event` ID.

### `trg.receipt`

| Attribute | Type | Notes |
|---|---|---|
| `type` | str | `trg.receipt` |
| `v` | i32 | `1` |
| `rule` | str | The rule's entity key |
| `rulecreator` | str | The rule's `$creator`, so an app can list receipts for its own rules |
| `action` | str | The action that ran |
| `status` | str | `ok`, `failed` or `skipped` |
| `deadline` | u64 | The block the rule was due at |
| `firedat` | u64 | The block at which the worker won the claim and ran the action |

Payload (`application/json`):

```json
{
  "reason": "target expired",
  "result": { "code": 200, "latencyMs": 412, "attempts": 1 }
}
```

`result` depends on the action: `code` (webhook HTTP status), `messageId` (Telegram), `newExpiresAt`
(extend), `error` (on failure), plus `latencyMs` and `attempts`. `skipped` means the rule was
correctly not acted on, for example `the target was deleted before it expired`.

### `trg.worker` (heartbeat)

| Attribute | Type | Notes |
|---|---|---|
| `type` | str | `trg.worker` |
| `v` | i32 | `1` |
| `version` | str | `arkiv-triggers/0.1.0` |
| `mode` | str | `any` (also fires public rules) or `own` (only rules assigned to it) |
| `lastblock` | u64 | The last block the worker fully processed; a restart resumes from here |
| `actions` | str | Comma-separated actions it can run, e.g. `webhook,receipt,extend` (`telegram` only with a bot token) |
| `operator` | str | Optional: the owner's main wallet |

Payload (`application/json`): `{ "sealKey": "0x…", "operatorSig": "0x…" }`. `sealKey` is the X25519
public key apps seal chat IDs to. `operatorSig` is the operator's EIP-191 signature over
`I operate Arkiv Triggers worker <worker address, lowercase>`; without it, `operator` is just a
claim and the SDK reports `operatorVerified: false`.

The worker renews its heartbeat every minute with one `executeBatch` (patch `lastblock` + extend 5
minutes). A worker that stops drops out of every heartbeat query on its own when the entity expires.

## Queries

All queries page 200 at a time and are pinned to one block (`.atBlock(head)`) so a page cursor stays
valid. `x` is a lowercase hex value.

| Who | Purpose | Query |
|---|---|---|
| Worker | Load rules (at most every 30 s when the event feed shows a change, and every 60 s regardless) | `type = "trg.rule"` (+ `app = …` if the worker is limited to one app) |
| Worker | Rules already finished (first full, then incremental) | `type = "trg.receipt"` and `firedat >= u64(lastScan - 300)` |
| Worker | Who holds which rule? (once before claiming, then until our claims are visible) | `type = "trg.claim"`: every live claim on the chain, which stays small because claims live 60 s |
| Worker | Was any of these rules fired already? (just before acting) | `type = "trg.receipt"` and `firedat >= u64(earliest deadline - 300)` |
| Worker | Resume after a restart | `type = "trg.worker"`, `.createdBy(myAddress)` |
| Worker | Expired or deleted? | `getEntity(target)`, then `getLogs` for `EntityDeleted` with `entityKey = target` from the rule's `$createdAt` |
| SDK `listRules` | A wallet's rules | `type = "trg.rule"` (+ `app = …`), `.createdBy(creator)` |
| SDK `listReceipts` | Receipts, newest first | `type = "trg.receipt"` + optional `rule = x`, `rulecreator = x`, `firedat >= u64(sinceBlock)` |
| SDK `getRule` | Audit trail | `getEntity(rule)` + `type = "trg.claim"` and `rule = x` + the receipts query |
| SDK `listWorkers` | Live workers | `type = "trg.worker"` (+ `operator = x`) |
| SDK `watch` | Live updates | Any event on the WebSocket feed triggers the receipt and rule queries above with `firedat >=` the newest receipt seen, at most once a second |

Expiry emits no event and the event feed cannot be filtered ([friction #2, #6](friction.md)), so the
worker checks deadlines on its own loop (every 4 s) and uses the WebSocket feed only as a "something
changed" signal.

### The same queries as text

This is the form the SDK sends (`String(query)`), useful for pasting into other tools:

```
type = str('trg.rule') AND $creator = addr(0xYourWallet)
type = str('trg.receipt') AND rule = str('0xrulekey')
type = str('trg.receipt') AND firedat >= u64(690000)
type = str('trg.worker')
```

## Wallets on Tiramisu

Every entity's `$creator` is the wallet that wrote it, so each role below can be checked on the
[explorer](https://tiramisu.explorer.arkiv.network).

| Role | Address | Writes |
|---|---|---|
| Public worker (Railway, `public-worker-production.up.railway.app`) | [`0xf856952A77F9439a55Ad418f5BB3928f4CE807Db`](https://tiramisu.explorer.arkiv.network/address/0xf856952A77F9439a55Ad418f5BB3928f4CE807Db) | `trg.claim`, `trg.receipt`, `trg.worker` for every public rule it fires; also worker B in the two-worker tests |
| Test runner | [`0x1c92087EC55B3B4114c7647ECADe3ab0b494C9b6`](https://tiramisu.explorer.arkiv.network/address/0x1c92087EC55B3B4114c7647ECADe3ab0b494C9b6) | Test targets and `trg.rule` entities in the live suites, and `trg.claim` / `trg.receipt` / `trg.worker` as worker A |
| Rule authors | Their own wallets | `trg.rule` from the dashboard or the SDK. OpenTrigger never holds them |

A worker's key lives only in its own environment (Railway variables, a local `.env`), never on
Arkiv. Bot tokens and access keys are server-side secrets; Telegram chat IDs are stored only sealed
to one worker's key.
