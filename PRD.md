# OpenTrigger: Team Vision

Oct 17, 2026 · @rick

OpenTrigger is database triggers for Arkiv. When data on Arkiv expires, is created or changes, something happens: a Telegram message, a webhook call, or a recorded receipt. Rules live on Arkiv, open-source workers carry them out, and every action leaves a signed receipt anyone can check.

Where we are: the trigger engine and the worker are already built. What's left is packaging them for other developers, and building the dashboard people use to create rules. Submission is due Oct 18, 2026.

The pitch in one line: "Pick what should happen on Arkiv, pick Telegram, and your phone tells you when it does."

## The problem

Arkiv sends no event when an entity expires. It just quietly disappears. So every team that needs "do something when this expires" writes its own fragile watcher, over and over.

Two pieces of proof that this gap is real:

- **Arkiv itself lists it as unbuilt.** The Arkiv ecosystem page names "OpenTrigger: a worker network that reacts to expiration or state changes and writes signed receipts back to Arkiv" as an idea nobody has built.
- **A real builder asked for it this week.** Vansh, building solo for this hackathon, asked in Discord whether a native expiry event is coming, because he's writing his own watcher to track expiresAt and confirm at the deadline.

The gap has three layers, and nothing covers any of them today:

| Layer | The problem today | What Triggers gives |
|---|---|---|
| Knowing when it happens | No expiry event, no purge log, and an expired entity looks the same as a deleted one | Workers watch deadlines, track deletes and confirm at the deadline block |
| Doing something at that moment | No smart contracts and no scheduler, so every team writes its own cron script | Rules ("when X, do Y") that any worker carries out |
| Proving it was done | Nothing records that an action happened, or who did it | A signed receipt on Arkiv, with $creator showing which worker did it |

If Arkiv adds a native expiry event later, the first layer gets easier and Triggers simply uses it. The other two layers still don't exist anywhere else.

## How it fits together

The dashboard and apps write rules into Arkiv and read receipts from it. Workers read rules from Arkiv and write claims and receipts back. They never talk to each other. The only direct call is a worker notifying the app (a signed webhook or a Telegram message) when a rule fires. If our dashboard goes down, rules still fire. If our worker goes down, anyone else's worker picks the jobs up.

## The core pieces

Everything in the system is one of these seven things. Think of Swiggy: Triggers is the whole service, rules are orders, and workers are delivery partners.

| Piece | What it is | Who writes it | Lives on Arkiv? |
|---|---|---|---|
| Rule | "When this happens, do that." An entity with type trg.rule. | The app or user, with their own wallet | Yes, until a few days after its deadline |
| Worker | A program that watches rules, does the action at the right time, and signs a receipt. A general executor that only does actions from a fixed menu, never code from a rule. | Whoever runs it (us, or a self-hoster) | No, it runs on a server |
| Claim | A 60-second lease saying "I'm handling this rule," so two workers never fire the same job. If the worker crashes, the claim expires and another worker takes over. | The worker | Yes, for 60 seconds |
| Receipt | Signed proof that a rule fired, when, the result, and which worker did it (its $creator). | The worker | Yes, about 30 days |
| Heartbeat | A small "I'm alive" entity each worker writes, expiring in 5 minutes and extended every minute. If it lapses, the worker is offline. | The worker | Yes, renewed every minute |
| Connection | A saved link to an outside service, like a user's Telegram chat, so any rule can reuse it. The chat ID is encrypted, never plain. | The user, once | Inside rule payloads, encrypted |
| Dashboard | The website where people create rules and watch receipts. Just one convenient screen: rules also work without it. | Us | No, it's a website on Vercel |

**Wallets:** the user's main wallet creates rules. Each worker has its own separate wallet for claims, receipts and heartbeats. A worker never uses the user's main wallet, so a hacked server can only lose a little test GLM.

**No relayer needed.** Workers sign their own transactions, and we want their address visible on receipts. A relayer is only an optional extra later, to pay gas for users who have no wallet.

## Two repos

We ship two separate public repos, both MIT licensed. They never import each other's code at runtime. The dashboard just installs our published npm package like any other developer would, which also proves the package works.

| Repo | What it is | Deployed where |
|---|---|---|
| arkiv-triggers | The npm package (SDK + worker + CLI), the Docker image, and the hackathon docs (arkiv/schema.md, arkiv/friction.md) | npm, plus our public worker on Railway |
| arkiv-triggers-dashboard | The Next.js website people use to create rules and watch receipts | Vercel |

### Repo 1: arkiv-triggers (SDK and worker)

```
arkiv-triggers/
├─ src/
│  ├─ index.ts       ← the SDK (everything below except startWorker)
│  ├─ worker.ts      ← startWorker (the engine we already built)
│  ├─ actions/       ← telegram.ts, webhook.ts, receipt.ts, extend.ts
│  ├─ schema.ts      ← rule, claim, receipt, heartbeat formats + version
│  └─ cli.ts         ← `npx arkiv-triggers-worker`, reads .env
├─ docker/worker.Dockerfile
├─ arkiv/schema.md   ← required by the hackathon
├─ arkiv/friction.md ← required by the hackathon
├─ .env.example      ← every setting, no real values
└─ README.md         ← 3-line quickstart first
```

What the SDK contains (import from `arkiv-triggers`):

| Function | What it does | Used by |
|---|---|---|
| `createTriggers({ wallet })` | Sets up the client. Needs only an Arkiv wallet, never a server URL. | Everyone |
| `createRule(rule)` | Writes one rule to Arkiv | Dashboard, apps |
| `createRules([rules])` | Writes several rules in one batch, one signature | Dashboard "Publish" |
| `deleteRule(key)` | Removes a rule before it fires | Dashboard |
| `listRules({ creator })` | All rules made by a wallet, with status | Dashboard rules page |
| `getRule(key)` | One rule plus its claims and receipts (the audit trail) | Rule details page |
| `listReceipts({ rule?, creator? })` | Receipts, newest first | Overview, activity |
| `watch({ onReceipt, onRule, onHeartbeat })` | Live updates over WebSocket | Dashboard live feed |
| `listWorkers({ operator? })` | Workers from their heartbeats, online or offline | Workers page |
| `sealForWorker(text, workerPubKey)` | Encrypts a Telegram chat ID so only that worker can read it | Connections |
| `verifyWebhook(body, signature, trusted)` | Checks a webhook really came from a trusted worker | App servers, n8n |
| `toBlock(date)` and `toDate(block)` | Converts between dates and Arkiv blocks (about 2 seconds each) | Editor, lists |
| `actions` and `templates` | Definitions of each THEN action (label, icon, fields) and ready rules | Dashboard editor |

The worker (import from `arkiv-triggers/worker`):

```ts
startWorker({
  privateKey,              // the worker's own wallet
  mode: "any" | "own",     // help everyone, or only rules assigned to me
  operator, operatorSig,   // links the worker to its owner (for the dashboard)
  telegramToken,           // optional: enables the Telegram action
  onFire,                  // optional: run your own code (own worker only)
})
```

Or with no code: `WORKER_KEY=0x... npx arkiv-triggers-worker`, or the Docker image.

### Repo 2: arkiv-triggers-dashboard (Next.js)

```
arkiv-triggers-dashboard/
├─ app/
│  ├─ page.tsx                 ← Overview
│  ├─ rules/page.tsx           ← Rules list
│  ├─ rules/new/page.tsx       ← Rule editor
│  ├─ rules/[key]/page.tsx     ← Rule details (audit trail)
│  ├─ activity/page.tsx        ← Live feed of all my receipts
│  ├─ workers/page.tsx         ← Workers and heartbeats
│  ├─ connections/page.tsx     ← Telegram and other connections
│  └─ settings/page.tsx        ← Link my own worker, preferences
├─ components/                 ← shell, cards, status dots, editor
├─ lib/arkiv.ts                ← public client (WebSocket) + wallet client
└─ package.json                ← depends on "arkiv-triggers" from npm
```

It's a static, client-side app (Next.js with client components, no API routes needed). Every page reads from Arkiv in the browser, and writes through the user's wallet. The only server piece we might add later is one serverless function for the "Ask AI" box, because an AI key can't live in the browser.

**Publishing checklist (repo 1):**

- [ ] package.json has `"files": ["dist"]`, so only built code is published
- [ ] Run `npm pack --dry-run` and read the file list before every publish
- [ ] No keys anywhere in code: always `process.env.WORKER_KEY`
- [ ] `.env` is in `.gitignore` in both repos
- [ ] Any key that was ever committed is treated as leaked and replaced

**Open code, secret keys.** The worker code is public on purpose. What keeps our worker trusted is its private key, which lives only in Railway's environment variables. Anyone else running the same code uses their own key, and receipts show exactly which key signed them.

## Self-hosting

Open source means anyone can run a worker, not that everyone must. Like email: anyone can run a mail server, but most people use Gmail, and both work together.

| Mode | What the app does | Deployment |
|---|---|---|
| 1. Use public workers (default) | Just writes rules | None. Our worker fires them. |
| 2. Worker inside their backend | `startWorker({ privateKey })` in 3 lines | None extra |
| 3. Separate worker | `npx arkiv-triggers-worker`, Docker, or one-click Railway | One small process |

Worker settings (`.env` on their server):

```
WORKER_KEY=0x...        # the worker's own wallet: SECRET, only on this server
OPERATOR=0x...          # their main wallet address (the one they connect to the dashboard): public
OPERATOR_SIG=0x...      # signature linking them to this worker, from the dashboard: public
WORKER_MODE=own         # "own" = only my rules, "any" = also help with public rules
TG_TOKEN=...            # only if this worker sends Telegram messages: SECRET
```

**How a rule picks its worker:** every rule has a `worker` field. Arkiv decides nothing.

- `worker: "any"`: any public worker may fire it.
- `worker: "0x7f3…"`: only that worker may fire it. Every other worker skips it.

**How the dashboard finds someone's own worker, with no ports or URLs:** the worker writes its heartbeat on Arkiv with `operator` set to the owner's main wallet. The dashboard asks Arkiv for heartbeats where operator equals the connected wallet, checks the owner's signature (so nobody can fake it), and shows "Your worker 0x7f3… · online." The worker only makes outgoing connections to Arkiv, so it works even on localhost behind a home router.

Self-hosters can use our hosted dashboard with their own worker. They just choose "My own worker" when creating rules. Or they can clone the dashboard repo and run it themselves (`pnpm dev`). Nothing needs to be reconfigured, because both only talk to Arkiv.

**Bonus for their own worker:** they can pass `onFire: async (rule) => { ... }` to run their own code directly (send an email, call Slack). That's safe because it's their code on their server. Public workers never run code from rules.

## Dashboard: layout and overview

**The look:** like Vercel's dashboard. Calm, black and white, mostly typography, one accent colour, thin borders, and little coloured status dots doing the talking. Developers already trust that look.

**How to get it fast:** Next.js + Tailwind + shadcn/ui components, with Vercel's free Geist font (Geist Sans for text, Geist Mono for addresses, keys and block numbers). Dark mode and light mode both supported from day one.

**The shell** (the same on every page):

```
┌─────────────────────────────────────────────────────────────────────────────┐
│ ▲ Triggers  /  0xYou…a3f            ● Tiramisu   ● Live    [ 0xYou…a3f ▾ ]  │
│ Overview   Rules   Activity   Workers   Connections   Settings      [ + New rule ] │
├─────────────────────────────────────────────────────────────────────────────┤
│                     (page content, centred, max width ~1200px)                   │
└────────────────────────────────────────────────────────────────────────────┘
```

- Top bar: logo, the connected wallet as a breadcrumb, a network badge ("Tiramisu"), a live indicator ("● Live" or "◌ Reconnecting"), and the wallet button.
- Tab bar under it, with the active tab underlined: Overview, Rules, Activity, Workers, Connections, Settings.
- "+ New rule" always visible on the right.
- On phones the tabs become a scrollable row.
- Optional: ⌘K command menu ("new rule", "go to workers", "paste an entity key").

### The Overview page (the first page a user sees)

Before connecting a wallet it explains the product in one screen:

```
            Rules on Arkiv. Actions on time.
   Pick what should happen on Arkiv, pick Telegram, and your phone tells you.

                    [ Connect wallet ]   [ Read the docs ]

   ⏰ When an entity expires  →  ✈ Telegram me        (3 example cards,
   📅 At a date and time    →  🔗 Call my webhook     clickable as templates)
   ⏳ 1 day before expiry    →  ⏳ Extend it 30 days
```

**Connect wallet** does three things automatically: connects MetaMask (or any injected wallet), adds the Tiramisu network if it's missing (chain ID 7738577), and checks the balance. If the balance is zero, it shows "You need free test GLM → Get it from the faucet" right there.

After connecting, the overview shows:

```
┌ Active rules ┐ ┌ Fired today ┐ ┌ Failed ┐ ┌ Workers online ┐ ┌ Test GLM ┐
│      4       │ │      7      │ │   1    │ │     2 ●       │ │  12.4    │
└──────────────┘ └─────────────┘ └────────┘ └────────────────┘ └──────────┘

Next up                                    Recent activity (live)
● Lease reminder     fires in 2h 14m      ✓ Lease reminder   Telegram sent  5:00 PM
● Ping my server     fires 18 Oct 5 PM    ✕ Listing alert    webhook 500    retrying

Setup checklist (disappears when done)
✓ Connect wallet   ✓ Get test GLM   ○ Connect Telegram   ○ Create your first rule
```

- **Stat cards:** active rules, fired today, failed, workers online, test GLM balance. Each card is clickable and opens the matching page.
- **Next up:** the next few rules about to fire, with live countdowns.
- **Recent activity:** the latest receipts, updating live.
- **Setup checklist:** guides a first-time user to their first fired rule, then hides itself.

## Dashboard: every page

| Page | Route | What it shows | Main actions |
|---|---|---|---|
| Overview | `/` | Stat cards, next rules to fire, recent activity, setup checklist | Connect wallet, get test GLM, + New rule |
| Rules | `/rules` | Every rule as a plain sentence, with status and countdown | Filter by status, search, open, duplicate, delete |
| Rule editor | `/rules/new` | The WHEN and THEN cards and side panel (see Form UX below) | Test, save draft, Publish |
| Rule details | `/rules/[key]` | The audit trail, deliveries table and the raw rule | Resend, duplicate, delete, open in explorer |
| Activity | `/activity` | A live, Vercel-logs-style stream of all my receipts | Filter by rule, status or worker |
| Workers | `/workers` | Every worker from heartbeats: public or mine, online or offline | Copy address, open in explorer |
| Connections | `/connections` | Saved connections (Telegram first) | Connect, test, remove |
| Settings | `/settings` | My own workers (linking), defaults, theme | Link my worker, set default "who fires" |

**Rules page.** Rows read like sentences, Vercel-deployments style, with a coloured dot on the left:

```
●  When rental 0xab12… expires (1h early) → Telegram me     Active   fires in 2h 14m    ⋯
✓  At 18 Oct, 5:00 PM → call my webhook                   Fired    5:00:03 PM · 0xA1…  ⋯
✕  When listing 0xcd34… expires → call my webhook          Failed   retrying 2 of 5    ⋯
○  When lease 0x91be… expires → Telegram me               Draft    not published      ⋯
```

Filter tabs: All, Active, Fired, Failed, Drafts. Statuses come from Arkiv: a rule with a receipt is Fired, a receipt with `status = failed` is Failed, a rule without one is Active, and Drafts live only in the browser.

**Rule details page (the audit trail).** Every step links to the Arkiv explorer, so anyone can check it:

```
Lease reminder                                   ✓ Fired     [ Duplicate ] [ ⋯ ]
When rental 0xab12… expires (1h early) → Telegram me · fired by any public worker

Timeline
● Created    by 0xYou…a3f        block 1,240,100   17 Oct 2:10 PM   ↗
● Claimed    by worker 0xA1…     block 1,250,001   18 Oct 4:00 PM   ↗
● Telegram   message sent        182 ms
● Receipt    by worker 0xA1…     block 1,250,003   18 Oct 4:00 PM   ↗

Deliveries
Attempt  Time         Result       Took    Worker
1        4:00:02 PM   200 OK       182ms   0xA1…

Raw rule  [ show ]   ← the attributes and payload exactly as stored on Arkiv
```

**Activity page.** One live stream, like Vercel's logs view: newest at the top, each line "time · rule · result · worker," new lines sliding in as receipts arrive. A pause button freezes the stream so people can read it.

**Workers page.**

```
Worker          Type     Status       Last seen    Fired   Actions it supports
0xA1…b20        Public   ● Online     20s ago      42      Telegram, webhook, receipt
0x7f3…c11       Yours    ● Online     45s ago       3      webhook, receipt
0x9c4…e02       Public   ○ Offline    3 min ago    17      webhook, receipt
```

**Connections page.** A card per service. Telegram shows "Connected as chat •••• 4821" with Test and Remove buttons. Slack and Discord cards say "Coming soon."

**Settings page.** "My workers" with a Link a worker flow (see "Using your own worker" below), the default "who fires" choice for new rules, and the theme switch.

## Live data: WebSocket vs polling

There are two ways to stay up to date. Polling means asking again and again ("anything new?" every few seconds), like checking WhatsApp every minute. A WebSocket subscription means Arkiv tells you the moment something happens, like a notification. The dashboard uses subscriptions; the worker uses both.

| Who | How it stays current | Why |
|---|---|---|
| Dashboard | Loads a snapshot once with a query, then subscribes with `watchEntityEvents` over a WebSocket, with no `fromBlock` | Live updates with no refresh loop. The judging rubric rewards exactly this. |
| Worker | Subscribes to create, extend and delete events, plus a polling tick every few seconds to check deadlines | Expiry sends no event, so deadlines must be checked |
| Worker after a restart | Replays events from its last saved block (`fromBlock`) | So it never misses a delete that happened while it was down |

**How the dashboard loads a page:**

1. **Snapshot:** query Arkiv once for the page's data (for example, my rules and their receipts).
2. **Subscribe:** open one WebSocket subscription for the whole app (in `lib/arkiv.ts`), shared by every page.
3. **React to events:** when a new entity appears, check its type. If it's a receipt for one of my rules, add it to the activity feed and update that rule's status. If it's a heartbeat extension, mark that worker online.
4. **Countdowns tick locally:** "fires in 2h 14m" is calculated in the browser from the deadline block and the current block. The current block is refreshed from new events or every 30 seconds. No network call per second.

```ts
// lib/arkiv.ts: one shared, live client
const pub = createPublicClient({
  chain: tiramisu,
  transport: webSocket("wss://rpc.tiramisu.db-chain.testnet.arkiv.network"),
})

export function subscribe(handlers) {
  return pub.watchEntityEvents({          // no fromBlock: pushed live, no polling loop
    onEntityCreated: handlers.onCreated,   // new rules, claims, receipts, heartbeats
    onExpiryExtended: handlers.onExtended, // heartbeats renewing = worker still online
    onEntityDeleted: handlers.onDeleted,   // rules removed
    onError: handlers.onError,             // show "Reconnecting"
  })
}
```

**When the connection drops** (it will, on bad Wi-Fi):

1. The top bar changes from "● Live" to "◌ Reconnecting."
2. Retry with backoff (1s, 2s, 5s, 10s).
3. Once reconnected, re-run the snapshot query first, then subscribe again. That fills in anything missed while offline, without needing `fromBlock`.
4. The top bar goes back to "● Live."

The SDK's `watch()` wraps all of this, so the dashboard and any other app get the same behaviour in one call.

## Using your own worker from the dashboard

A self-hoster runs our worker code with their own key, then uses our hosted dashboard as normal. The dashboard never needs their server's URL or port. It only needs the worker's address, and it finds that on Arkiv.

**The flow, step by step:**

1. **Start the worker** with `npx arkiv-triggers-worker` (or Docker, or `startWorker()` in their backend). It prints its address, like `Worker running as 0x7f3…c11`.
2. **Fund it** with free test GLM from the faucet, so it can pay gas for claims, receipts and heartbeats.
3. **Link it in the dashboard:** Settings → My workers → Link a worker → paste `0x7f3…`. Their main wallet signs a short message ("I operate worker 0x7f3…"), and the dashboard shows the signature to copy.
4. **Paste that signature** into the worker's `.env` as `OPERATOR_SIG`, with `OPERATOR` set to their main wallet. Restart the worker.
5. **The worker writes its heartbeat** on Arkiv with `operator` set to their main wallet, plus the signature.
6. **The dashboard finds it:** it asks Arkiv for heartbeats where operator equals the connected wallet, checks the signature, and shows "Your worker 0x7f3… · ● Online." A fake heartbeat can't produce their signature, so it's ignored.
7. **Use it in rules:** in the editor's "Who fires it" setting, "My own worker 0x7f3…" now appears. The rule is saved with `worker = 0x7f3…`, so public workers skip it and only their worker fires it.

What the dashboard shows in the editor's "Who fires it" setting:

```
Who fires this rule?
( • ) Any public worker                         ← default
(   ) My own worker   0x7f3…c11   ● online
(   ) A specific worker   [ paste address ]
```

- If their worker is offline, the option stays selectable but shows "○ offline, rules will wait until it's back."
- If the action is Telegram, only our Telegram worker is allowed, and the other options are greyed out with a note: "Telegram messages are sent by the OpenTrigger bot worker." A self-hoster who wants Telegram on their own worker creates their own bot and sets `TG_TOKEN`.

**Two wallets, never one:** the main wallet (MetaMask) creates rules and signs the link. The worker's wallet lives only on the server and signs claims, receipts and heartbeats. If a server is ever hacked, only a little test GLM is at risk.

## The rule editor: every field

The editor and the rule are two different things. The editor is just a screen in the browser. On Publish, it turns the cards into rule entities (one trigger with two actions becomes two rules, written together in one batch). After that, the editor doesn't matter: workers only read the rules.

**The rule of thumb:** anything workers search on goes in attributes. Everything else goes in the payload. Never put secrets or personal data in plain text, because rules are public.

### WHEN card (the trigger)

| Field | Stored as | Type | Example |
|---|---|---|---|
| Trigger type | attribute `on` | str | `expire` or `block` |
| Entity (for expire) | attribute `target` | str | `0xab12…`, picked from the user's own entities |
| Date and time (for block) | attribute `fireAt` | u64 | `1250000` (the dashboard converts the date to a block, about 2 seconds each) |
| Fire early by (optional) | attribute `offset` | u64 | `1800` blocks, about 1 hour |

### THEN card (the action)

| Field | Stored as | Type | Example |
|---|---|---|---|
| Action type | attribute `action` | str | `telegram`, `webhook`, `receipt`, `extend` |
| Message | payload `message` | text | `⏰ Your entity {entity} expires at {time}` |
| Telegram chat | payload `chat` | encrypted | Encrypted to the worker's key, never plain |
| Webhook URL | payload `url` | text | `https://myapp.com/hook` (warn if it contains a secret) |
| Extend by | payload `extendDays` | number | `30` |

### Settings (collapsed, with defaults)

| Field | Stored as | Default |
|---|---|---|
| Who fires it | attribute `worker` | `any` (forced to our Telegram worker when the action is Telegram) |
| Repeat | attribute `repeat` | `once` (or `every`, for "each new matching entity" rules later) |
| Rule name | payload `name` | "Lease reminder" |
| Retries | payload `retries` | 3 |

### Filled in automatically (never shown)

| Field | Value | Why |
|---|---|---|
| `type` | `trg.rule` | So workers can find rules |
| `v` | 1 (i32) | Format version, so the format can grow safely |
| `app` | `triggers-dashboard` | Lets apps find only their own rules |
| Rule expiry | deadline + about 7 days | Old rules clean themselves up |
| `$creator` | the user's wallet | Set by Arkiv itself, proves who made the rule |

**Arkiv limits to respect:** attribute names up to 32 bytes, string values up to 128 bytes (that's why URLs and messages go in the payload), at most 32 attributes (we use about 10), and numbers we compare (`fireAt`, `offset`) must be u64 so range queries work.

## Form UX: how the rule editor should feel

**The goal:** a first-time user goes from "New rule" to a live rule in under a minute, without reading docs and without seeing a block number unless they want to. The model is Zapier's editor: step cards in the middle, one focused panel on the side.

The editor layout:

```
New rule · Draft                                              [ Save draft ] [ Publish ]
“When rental 0xab12… expires, 1 hour early → Telegram me”    ← live summary sentence

 Templates            ┌────────────────────────────┐      Side panel (for the selected card)
 ⏰ Expiry → TG       │ ✓ ⏰ WHEN                   │      Setup › Configure › Test
 📅 Time → webhook   │ Entity expires             │      ─────────────────────────────
 ⏳ Keep alive        └────────────────────────────┘      Entity   [ 🔍 My rental · 0xab12… ▾ ]
                                    +                             expires 18 Oct, 5:00 PM (in 1d 2h)
                      ┌────────────────────────────┐      Fire early [ 15m ][ 1h ✓][ 1d ][ custom ]
                      │ ! ✈ THEN                    │      → fires 18 Oct, 4:00 PM
                      │ Telegram · 1 field missing │
                      └────────────────────────────┘      ▸ Advanced: who fires it, retries
                                    +
```

**Principles:**

1. **One thing at a time.** Clicking a card opens only that card's fields in the side panel. Settings like "who fires it" and retries stay hidden under "Advanced" with good defaults.
2. **Always show the rule as a sentence.** The summary line at the top rewrites itself as they type, so they always know what they're building.
3. **Show times, not blocks.** Every deadline is shown as a date and time in the user's own timezone ("18 Oct, 4:00 PM IST"). The block number appears only in small grey mono text for people who want it.
4. **Validate as they go, never only at the end.** Each card shows a green ✓ when complete or a yellow ! with the reason ("1 field missing"). Publish stays disabled with a tooltip that says exactly what's missing.
5. **Nothing touches the wallet until Publish.** Drafts autosave in the browser, so closing the tab never loses work.

**Field by field:**

| Field | How it should work |
|---|---|
| Trigger type | Big tiles with icons: "Entity expires" and "At a date and time" (more tiles greyed out as "coming soon") |
| Entity | A searchable dropdown of the user's own entities (queried by owner), each showing its type and "expires in 6d 3h." Pasting any entity key also works. Instantly checks that it exists and shows its deadline. |
| Fire early | Chips: 15 min, 1 hour, 1 day, Custom. Under them: "→ fires 18 Oct, 4:00 PM." |
| Date and time | A date-time picker with the timezone label, plus quick chips ("in 5 min," "tomorrow 9 AM"). Past times are blocked with a clear message. |
| Action | Tiles: Telegram, Webhook, Record receipt, Extend. A tile that can't be used shows why on hover ("Connect Telegram first"). |
| Message | A text box with clickable placeholder chips (`{entity}`, `{time}`, `{rule}`) that insert at the cursor, plus a live preview styled like a real Telegram message, using sample values. |
| Telegram chat | If connected: "Sending to •••• 4821 ✓." If not: a "Connect Telegram" button that opens a small modal, without leaving the editor. |
| Webhook URL | Checks `https://` as they type, warns if it looks like it contains a secret, and has Send test next to it, which shows the response inline ("200 OK in 182 ms"). |
| Who fires it (Advanced) | Radio list: any public worker, my own worker (with live online dot), a specific address. Locked to our worker for Telegram, with the reason shown. |

**The Test tab** (before publishing): a short checklist per card, so people trust it before they sign:

```
✓ Entity 0xab12… exists, expires 18 Oct 5:00 PM
✓ Fire time is in the future (18 Oct 4:00 PM)
✓ Telegram connected · [ Send test message ] → ✓ delivered
✓ A worker that can fire this is online (0xA1…)
```

**The Publish moment:**

1. Clicking Publish opens a short review: the summary sentence, "You'll sign 1 transaction," and a small "what gets stored on Arkiv" preview (public fields only, with a note that the chat ID is encrypted).
2. The button walks through clear states: Waiting for your wallet… → Writing to Arkiv… → Live ✓.
3. On success: a confetti-free, calm confirmation with "fires in 1d 1h," an explorer link, and "View rule."
4. Errors in plain words: "You cancelled the signature. Nothing was written." or "Not enough test GLM. Get some from the faucet →" (with the link).

**Small touches:**

- Templates on the left fill both cards in one click, leaving only the blanks.
- Keyboard: Enter moves to the next field, ⌘/Ctrl + Enter publishes.
- Phones: the side panel becomes a bottom sheet, and the cards stack full width.
- "View as code" toggle shows the exact `createRule()` call for this rule, so developers can copy it into their app.
- Later: an "Ask AI" box above the cards that fills them from a sentence ("Telegram me an hour before 0xab12 expires").

## THEN actions, Telegram and safety

The THEN step is a small menu of ready actions. Each action is defined once and used everywhere: the dashboard uses the definition to draw its form, and the worker uses the same name to know how to run it. Adding Slack or Discord later means one new entry on each side.

| Action | What happens | Which workers can fire it |
|---|---|---|
| ✈ Telegram | Our bot sends the user a message, with `{entity}`, `{time}` and `{rule}` filled in | Only our Telegram worker (it holds the bot token and can decrypt the chat ID) |
| 🔗 Webhook | A signed POST to the user's URL (their server, or n8n, Make or Zapier) | Any worker |
| 🧾 Record receipt | Just the receipt on Arkiv; apps can watch for it | Any worker |
| ⏳ Extend entity | Extends the target entity | Any worker, if the target allows permissionless extension |

**Connecting Telegram (once per user):**

1. The user picks Telegram in a THEN card and clicks Connect Telegram.
2. It opens our bot. They tap Start, and the bot replies with their chat code.
3. They paste it into the dashboard, which encrypts it to our worker's key and saves it as their connection (in the browser for now).
4. Every later rule reuses it automatically. They only type the message.

**Safety rules (non-negotiable):**

- **Rules never contain code.** Workers only run actions from the fixed menu. Otherwise a stranger could make our worker run anything.
- **No secrets in rules.** Rules are public. A Slack or Discord webhook URL is a secret (anyone holding it can post), so it never goes in a rule. Bot tokens live only in the worker's environment variables.
- **No personal data in plain text or hashed.** The hackathon bans it. Chat IDs are encrypted, which is allowed.
- **Every webhook is signed.** The worker signs each message with its key (header `x-trg-sig`). Receivers check the signer matches a trusted worker and ignore anything else.

**Where n8n fits:** n8n is a separate drag-and-drop automation tool. Its webhook URL is just another webhook, so it needs no special screen. We add a hint under the URL field ("Works with n8n, Make or Zapier"), a Send test button that fires a sample signed message (n8n needs one to map fields), and a short guide in the README. Triggers decides when; any app or automation tool decides what happens next.

## Checklists

### Packaging

- [ ] Package arkiv-triggers with the `/worker` entry point and the `npx` command, built with tsup
- [ ] Telegram action in the worker (bot token from env, placeholders filled in)
- [ ] One public worker deployed on Railway, funded from the faucet
- [ ] Docker image and README quickstart (create a rule in 1 line, run a worker in 3)

### Dashboard

- [ ] Connect wallet (with automatic Tiramisu network setup) and a "Get free test GLM" link
- [ ] My rules list with status chips and countdowns
- [ ] Rule editor: WHEN card, THEN card, side panel with Setup → Configure → Test, Draft → Publish
- [ ] THEN actions: Telegram (with Connect Telegram), webhook (with Send test), receipt
- [ ] Rule details: audit trail timeline with explorer links
- [ ] Live feed over WebSocket
- [ ] Deployed on Vercel

### Submission (these are gates: missing one means no score)

- [ ] Public MIT repo
- [ ] `/arkiv/schema.md`: every entity type, attributes, expiry per type, and the queries
- [ ] `/arkiv/friction.md`: real issues with versions and steps to reproduce
- [ ] Wallet addresses that create our entities on Tiramisu (our worker, our test wallets)
- [ ] Demo video, 3 minutes or less
- [ ] Disclose any pre-existing work with the baseline commit

**The demo** (under 3 minutes): create a rule with the Telegram action on an entity that expires in 3 minutes, publish, wait, the phone buzzes, the receipt appears in the live feed, then click through to the Arkiv explorer. End with Arkiv's own "unbuilt" listing and Vansh's question as proof that it's needed.

## Roadmap (write in the README, don't build now)

- Self-hoster linking in the dashboard (operator signatures and heartbeats)
- More triggers: new entity matching a query, attributes changed, ownership transferred, deleted
- Filters ("only if salary is above X"), multiple actions per rule, and chained rules (a failed receipt triggers an alert)
- "Ask AI" box that fills the editor from a sentence
- A visual node canvas as an "Advanced view" (React Flow)
- Slack and Discord actions, and an official n8n node
- Shared templates published as entities on Arkiv
- Paying workers on mainnet: a small prepaid reward per rule, like Chainlink Automation and Gelato

## Open questions to check today

Each of these takes about 5 minutes to test on Tiramisu, and each one changes how we build something.

- [ ] Does `lte` work on our own u64 attributes? The Arkiv SDK's tests only show range comparisons on `$expiresAt`. If it's refused, the worker fetches `on = "block"` rules and filters by `fireAt` in code instead.
- [ ] What exact shape do attributes have in query results? Check `r.attributes` before building the worker's matching and the dashboard's list.
- [ ] Does the public Tiramisu RPC accept calls from a browser? It should, since the Arkiv Hub's "Try it out" works from the browser. If our site is blocked, we need a tiny proxy, and that goes in friction.md.
- [ ] Do two workers racing in the same block behave correctly? After writing a claim, re-read the claims and let the oldest one win. Test it with two workers on purpose.
- [ ] Does our worker replay deletes after a restart? It should start watching from its last saved block, so it never mistakes a delete that happened while it was down for an expiry.
- [ ] Telegram chat linking: confirm the bot's "tap Start, get your code" flow works, and decide where the connection is stored (browser for now).
