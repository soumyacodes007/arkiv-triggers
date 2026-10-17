# arkiv-triggers

[![Deploy on Railway](https://railway.com/button.svg)](https://railway.com/deploy/ocVIqZ)

Database triggers for [Arkiv](https://arkiv.network). When an entity expires, or a block (a date and
time) arrives, something happens: a Telegram message, a signed webhook, an extension, or just a
recorded receipt. Rules live on Arkiv, open-source workers carry them out, and every firing leaves a
receipt on Arkiv whose `$creator` is the worker that did it.

Arkiv emits no event when an entity expires, so until now every app that cared ran its own cron
script. This package is that script, shared: write a rule, and any worker on the network fires it.

## Quickstart

Create a rule (one line, with an Arkiv wallet client):

```ts
await createTriggers({ wallet }).createRule({ trigger: { on: "expire", target: entityKey }, action: "webhook", url: "https://myapp.com/hook" })
```

Run a worker (three lines, from any folder):

```bash
npx arkiv-triggers new-key > .env
# fund the printed address with test GLM: https://hub.arkiv.network/faucet
npx arkiv-triggers
```

That worker now fires public rules, writes a heartbeat every minute, and signs a receipt for every
rule it fires. Rules with `worker: "any"` (the default) are fired by whichever public worker gets
there first, so an app that only writes rules needs no worker of its own.

## Install

```bash
npm install arkiv-triggers @arkiv-network/sdk viem
```

Node 22 or later. The package runs on Arkiv's Tiramisu testnet (chain 7738577).

## Writing rules

```ts
import { ExpirationTime, createWalletClient, str } from "@arkiv-network/sdk"
import { tiramisu } from "@arkiv-network/sdk/chains"
import { http } from "viem"
import { privateKeyToAccount } from "viem/accounts"
import { createTriggers, sealForWorker } from "arkiv-triggers"

const wallet = createWalletClient({ chain: tiramisu, transport: http(), account: privateKeyToAccount(process.env.APP_KEY) })
const triggers = createTriggers({ wallet, app: "seat-holds" })

// A seat hold that expires in 2 minutes…
const hold = await wallet.createEntity({
  payload: new TextEncoder().encode("seat 14C"),
  contentType: "text/plain",
  attributes: { type: str("hold") },
  expires: ExpirationTime.fromMinutes(2),
})

// …and what happens when it does.
await triggers.createRule({
  name: "Release seat 14C",
  trigger: { on: "expire", target: hold.entityKey },
  action: "webhook",
  url: "https://tickets.example.com/hooks/hold-expired",
  message: "{rule}: hold {entity} expired at {time}",
})
```

### Triggers

| Trigger | Fires at |
|---|---|
| `{ on: "expire", target, offset? }` | The target's `$expiresAt`, minus `offset` blocks. Extending the target moves it; deleting the target skips it |
| `{ on: "block", fireAt, offset? }` | Block `fireAt`. Use `triggers.toBlock(new Date(...))` to turn a date into a block |

Blocks are 2 seconds apart. `offset: 1800n` is one hour early.

### Actions

Actions come from a fixed menu; rules never contain code.

| Action | Fields | What the worker does |
|---|---|---|
| `receipt` | none | Writes the receipt and nothing else. Apps can `watch()` for it |
| `webhook` | `url`, `message?` | Signed `POST` to the URL (retried with the same event ID) |
| `telegram` | `chat` (sealed), `message` | Our bot sends the message. Fired only by a worker holding the bot token |
| `extend` | `extendDays` | Extends the target, if it was created with `permissionlessExtension` |

`message` can use `{entity}`, `{time}` and `{rule}`. Optional on every rule: `worker` (`"any"` or one
worker's address), `retries` (0–10, default 3) and `name`.

**Rules are public.** Never put a secret in a URL (a Slack or Discord webhook URL is a secret).
`createRule` returns `warnings` when a URL looks like one. A Telegram chat ID must be sealed:

```ts
const [bot] = (await triggers.listWorkers()).filter((w) => w.actions.includes("telegram"))
await triggers.createRule({
  trigger: { on: "block", fireAt: await triggers.toBlock(new Date("2026-10-20T09:00:00Z")) },
  action: "telegram",
  worker: bot.worker,
  chat: sealForWorker(chatCode, bot.sealKey), // chatCode: what the bot replies to /start
  message: "Rent is due today",
})
```

### Reading what happened

```ts
await triggers.listRules({ creator: wallet.account.address })  // each with status: active | fired | failed
await triggers.getRule(ruleKey)                                 // audit trail: rule, live claims, receipts
await triggers.listReceipts({ creator: wallet.account.address }) // newest first
await triggers.listWorkers()                                    // live workers from their heartbeats

const stop = triggers.watch({
  creator: wallet.account.address,
  onReceipt: (r) => console.log(r.status, r.action, r.reason, "by", r.worker),
  onStatus: (s) => console.log(s), // "live" | "reconnecting"
})
```

`watch()` reconnects with backoff (1, 2, 5, 10 s) and re-reads on reconnect, so nothing is missed.

### Receiving a webhook

Every webhook body is signed by the worker's wallet. Verify it against the raw body before trusting
it, and drop repeats by `x-trg-event` (the same on every retry of one firing):

```ts
import { verifyWebhook, WEBHOOK_HEADERS } from "arkiv-triggers"

const TRUSTED = ["0x1c92087EC55B3B4114c7647ECADe3ab0b494C9b6"] // the workers you trust

app.post("/hooks/hold-expired", express.text({ type: "*/*" }), async (req, res) => {
  const v = await verifyWebhook(req.body, req.header(WEBHOOK_HEADERS.signature), TRUSTED)
  if (!v.ok) return res.status(401).send(v.reason)
  const event = JSON.parse(req.body) // { event, rule, ruleName, trigger, target, deadline, firedAt, message, worker }
  // …release the seat, once per event.event
  res.sendStatus(200)
})
```

Works the same from n8n, Make or Zapier: their webhook URL is just another URL.

## Running a worker

For one-click hosting, use the Railway button above. Enter your own funded `WORKER_KEY` and
`ARKIV_ACCESS_KEY`; add `TG_TOKEN` only if you want Telegram. The template uses
`docker/worker.Dockerfile`, `/healthz`, and one replica. Keep that worker wallet off other running
workers.

Pick whichever fits; all three run the same code.

| How | Command |
|---|---|
| CLI | `WORKER_KEY=0x… npx arkiv-triggers` (installed: `arkiv-triggers-worker`) |
| Docker | `docker build -f docker/worker.Dockerfile -t arkiv-triggers-worker .` then `docker run --env-file .env -p 8080:8080 arkiv-triggers-worker` |
| Inside your backend | `import { startWorker } from "arkiv-triggers/worker"` |

```ts
import { startWorker } from "arkiv-triggers/worker"

const worker = await startWorker({
  privateKey: process.env.WORKER_KEY,   // the worker's own wallet, never your main one
  mode: "own",                           // only rules assigned to this worker
  onFire: (rule, info) => console.log("fired", rule.name, info.eventId), // your own code, own rules only
})
```

Settings (all from the environment, or a `.env` in the current folder; see [`.env.example`](.env.example)):

| Variable | Secret? | Meaning |
|---|---|---|
| `WORKER_KEY` | **yes** | The worker's own wallet key. Fund it from the [faucet](https://hub.arkiv.network/faucet) |
| `WORKER_MODE` | no | `any` (default): also fire public rules. `own`: only rules assigned to this worker |
| `OPERATOR`, `OPERATOR_SIG` | no | Your main wallet, and its signature linking it to this worker (from the dashboard) |
| `TG_TOKEN` | **yes** | A Telegram bot token, to enable the Telegram action and the `/start` chat-code reply |
| `ARKIV_ACCESS_KEY` | **yes** | An Arkiv Hub access key. Needed in practice: without one the worker shares the anonymous query budget and stalls when it runs out. Give each long-running worker its own key |
| `ARKIV_RPC_URL`, `ARKIV_WS_URL` | no | Override the Tiramisu endpoints |
| `PORT` | no | Serve `GET /healthz` (200 while the loop moves, 503 when stuck for 2 minutes) |

A worker needs nothing else: no database, no volume. It finds its place again after a restart from
its own heartbeat on Arkiv.

## How it works

1. **Rules** are `trg.rule` entities. A worker loads them, and the WebSocket event feed tells it when
   to reload.
2. **Every 4 seconds** the worker works out each rule's deadline. Expiry emits no event, so it checks
   blocks itself.
3. **When a rule is due**, the worker confirms it: an expire rule's target must really have expired.
   If the target was deleted instead (found from `EntityDeleted` logs), the receipt says `skipped`.
4. **Claim:** the worker writes a `trg.claim` lease (60 s) for every rule due in that tick, in one
   transaction, and re-reads until its claims are visible. The earliest claim wins, so two workers
   don't both fire a rule. A worker that dies mid-claim loses the lease after 60 s.
5. **Act and receipt:** the winner runs the actions in parallel and writes the `trg.receipt`s (30 days), again in one transaction, with the
   status, the deadline, the block it fired at and the result.
6. **Heartbeat:** `trg.worker`, renewed every minute, lives 5 minutes. A dead worker drops off.

Workers never talk to each other; Arkiv is the only shared state. Full formats and every query are
in [`arkiv/schema.md`](arkiv/schema.md). Rough edges we hit in Arkiv are in
[`arkiv/friction.md`](arkiv/friction.md).

## Security

- **No secrets or personal data on Arkiv, plain or hashed.** Chat IDs are sealed to one worker's key
  (X25519 + XChaCha20-Poly1305); tokens and keys stay in the worker's environment.
- **Two wallets.** Your main wallet writes rules. The worker's wallet lives only on its server and
  signs claims, receipts, heartbeats and webhooks. A compromised server risks a little test GLM.
- **Webhooks are signed** (EIP-191, header `x-trg-sig`), and workers refuse private, loopback and
  link-local addresses, so a public rule cannot make a worker call into its own network.
- **Receipts can't be forged:** their worker is Arkiv's own `$creator`.

## Development

```bash
npm install
npm run typecheck
npm test                 # unit tests, no network
npm run test:live:sdk      # SDK against Tiramisu (needs WORKER_A_PRIVATE_KEY with test GLM in .env.local)
npm run test:live:worker   # a real worker fires real rules on Tiramisu (~5 min)
npm run test:live:network  # two workers share rules: takeover, downtime, race (needs WORKER_B_PRIVATE_KEY too)
npm run test:live:telegram # sends one real Telegram message (needs TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID)
npm run build
```

`spike/` holds the one-question scripts behind each design decision and each friction entry.

## Roadmap

Not built yet:

- More triggers: a new entity matching a query, attributes changed, ownership transferred, deleted
- Filters ("only if salary is above X"), several actions per rule, chained rules
- Receiver acknowledgments as entities, and retries until acknowledged
- Slack and Discord actions, an official n8n node
- Shared rule templates published as Arkiv entities
- Paying workers on mainnet: a small prepaid reward per rule

## License

[MIT](LICENSE)
