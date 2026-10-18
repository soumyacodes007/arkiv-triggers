#!/usr/bin/env node
// `npx arkiv-triggers` (or `arkiv-triggers-worker` once installed): runs a worker configured from the
// environment (or a .env file in the current folder). `npx arkiv-triggers new-key` prints a fresh wallet.
//
// Settings (see .env.example): WORKER_KEY (required), WORKER_MODE, OPERATOR, OPERATOR_SIG, TG_TOKEN,
// ARKIV_ACCESS_KEY, ARKIV_RPC_URL, ARKIV_WS_URL. If PORT is set (Railway, Fly, Docker), the worker
// also serves GET /healthz: 200 while the loop keeps moving, 503 once it has been stuck for 2 minutes.

import { existsSync } from "node:fs"
import { createServer } from "node:http"
import { createPublicClient } from "@arkiv-network/sdk"
import { tiramisu } from "@arkiv-network/sdk/chains"
import { type Hex, formatEther, http, isAddress, isHex } from "viem"
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts"
import { rpcOptions } from "./query"
import { watchProgress } from "./progress"
import { WORKER_VERSION, startWorker } from "./worker"

const FAUCET = "https://hub.arkiv.network/faucet"
const EXPLORER = "https://tiramisu.explorer.arkiv.network/address/"
const STUCK_MS = 120_000

// Signals are handled from the very start: in a container this process is PID 1, which ignores
// SIGTERM without a handler, so a stop during startup would otherwise hang until it is killed.
let shutdown: (() => Promise<void>) | undefined
let stopping = false
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, async () => {
    if (stopping || !shutdown) process.exit(stopping ? 1 : 0) // a second signal forces it; nothing to finish yet
    stopping = true
    console.log(`[OpenTrigger] ${sig}: finishing actions in flight…`)
    await shutdown()
    process.exit(0)
  })
}

const arg = process.argv[2]
if (arg === "-h" || arg === "--help" || arg === "help") {
  console.log(`OpenTrigger worker (${WORKER_VERSION})
Rules on Arkiv. Actions on time.

  npx arkiv-triggers            run a worker (reads the environment, then ./.env)
  npx arkiv-triggers new-key    print a new wallet to use as WORKER_KEY

Once the package is installed, the same command is also available as arkiv-triggers-worker.

Required: WORKER_KEY, the worker's own wallet key, funded with test GLM from ${FAUCET}
Optional: WORKER_MODE (any|own), OPERATOR, OPERATOR_SIG, TG_TOKEN, ARKIV_ACCESS_KEY,
          ARKIV_RPC_URL, ARKIV_WS_URL, PORT (serves /healthz)`)
  process.exit(0)
}
if (arg === "new-key") {
  const key = generatePrivateKey()
  console.log(`WORKER_KEY=${key}`)
  console.error(`\nAddress: ${privateKeyToAccount(key).address}
Put the line above in the worker's .env (never commit it), then fund the address at ${FAUCET}.`)
  process.exit(0)
}
if (arg) {
  console.error(`Unknown command "${arg}". Try --help.`)
  process.exit(1)
}

if (existsSync(".env")) process.loadEnvFile(".env") // values already in the environment win
const env = (name: string) => process.env[name]?.trim() || undefined

/** Prints the problem and exits 1 without process.exit() (which can abort on Windows with sockets open). */
function fail(msg: string): undefined {
  console.error(msg)
  process.exitCode = 1
  return undefined
}

async function main() {
  const key = env("WORKER_KEY")
  if (!key) return fail("WORKER_KEY is not set. Run `npx arkiv-triggers new-key` to make one (never use your main wallet).")
  if (!isHex(key) || key.length !== 66) return fail("WORKER_KEY must be a 0x-prefixed 32-byte hex private key.")
  const mode = env("WORKER_MODE") ?? "any"
  if (mode !== "any" && mode !== "own") return fail(`WORKER_MODE must be "any" or "own", not "${mode}".`)
  const operator = env("OPERATOR")
  const operatorSig = env("OPERATOR_SIG")
  if (operator && !isAddress(operator)) return fail("OPERATOR must be a wallet address.")
  if (!!operator !== !!operatorSig) return fail("Set OPERATOR and OPERATOR_SIG together (the signature comes from the dashboard's Link a worker step).")
  const accessKey = env("ARKIV_ACCESS_KEY")
  if (!accessKey) {
    console.warn(
      "[OpenTrigger] ARKIV_ACCESS_KEY is not set: this worker uses Arkiv's anonymous query budget, which a busy worker can exhaust (queries then stall). Get a key at https://hub.arkiv.network/api-keys.",
    )
  }
  const rpcUrl = env("ARKIV_RPC_URL")

  // A worker with no gas cannot claim, so say how to fix it before anything else.
  const address = privateKeyToAccount(key as Hex).address
  const reader = createPublicClient({
    chain: tiramisu,
    transport: http(rpcUrl ?? tiramisu.rpcUrls.default.http[0], rpcOptions(accessKey ? { "X-API-KEY": accessKey } : undefined)),
  })
  const balance = await reader.getBalance({ address })
  if (balance === 0n) return fail(`Worker ${address} has no test GLM yet. Fund it at ${FAUCET}, then start again.`)

  // The worker handles its own errors; this only keeps a stray one (a network blip) from ending the process.
  process.on("unhandledRejection", (e) => console.error(`[OpenTrigger] unhandled: ${(e as Error)?.message ?? e}`))


  let readProgress = () => 0n
  const watchdog = watchProgress(() => readProgress(), () => {
    console.error(`[OpenTrigger] firing loop made no block progress for ${STUCK_MS / 1000} s; exiting for the supervisor to restart`)
    // End this process before a replacement can use the same wallet. A timed-out Promise alone
    // does not cancel an old pass, which could otherwise resume and write beside the new pass.
    process.exit(1)
  }, STUCK_MS)
  const worker = await startWorker({
    privateKey: key as Hex,
    mode,
    operator: operator as Hex | undefined,
    operatorSig: operatorSig as Hex | undefined,
    telegramToken: env("TG_TOKEN"),
    accessKey,
    rpcUrl,
    wsUrl: env("ARKIV_WS_URL"),
  })
  readProgress = () => worker.stats().lastBlock
  console.log(`[OpenTrigger] balance ${formatEther(balance)} GLM · ${EXPLORER}${address}`)
  console.log(`[OpenTrigger] seal key ${worker.sealKey}`)

  const port = Number(env("PORT"))
  const server = port
    ? createServer((req, res) => {
        if (req.url !== "/healthz") return void res.writeHead(404).end()
        const s = worker.stats()
        const ok = watchdog.healthy()
        res.writeHead(ok ? 200 : 503, { "content-type": "application/json" })
        res.end(JSON.stringify({ ok, worker: worker.address, version: WORKER_VERSION, ...s, lastBlock: String(s.lastBlock) }))
      }).listen(port, () => console.log(`[OpenTrigger] health check on :${port}/healthz`))
    : undefined

  shutdown = async () => {
    watchdog.stop()
    server?.close()
    await worker.stop()
  }
}

await main()
