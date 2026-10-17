// Shared setup for the phase 1 spike scripts: env, clients with the access key, small helpers.
import { existsSync } from "node:fs"
import { createPublicClient, createWalletClient } from "@arkiv-network/sdk"
import { tiramisu } from "@arkiv-network/sdk/chains"
import { http, webSocket, type Hex } from "viem"
import { privateKeyToAccount } from "viem/accounts"

for (const f of [".env.local", ".env"]) if (existsSync(f)) process.loadEnvFile(f)

export const RPC_URL = process.env.ARKIV_RPC_URL ?? "https://rpc.tiramisu.db-chain.testnet.arkiv.network"
export const WS_URL = process.env.ARKIV_WS_URL ?? "wss://rpc.tiramisu.db-chain.testnet.arkiv.network"
const ACCESS_KEY = process.env.ARKIV_ACCESS_KEY

export const transport = () =>
  http(RPC_URL, ACCESS_KEY ? { fetchOptions: { headers: { "X-API-KEY": ACCESS_KEY } } } : {})

export const publicClient = createPublicClient({ chain: tiramisu, transport: transport() })
export const socketClient = () => createPublicClient({ chain: tiramisu, transport: webSocket(WS_URL) })

export function walletFor(envName: string) {
  const key = process.env[envName] as Hex | undefined
  if (!key) throw new Error(`${envName} is not set in .env.local`)
  return createWalletClient({ chain: tiramisu, transport: transport(), account: privateKeyToAccount(key) })
}

/** Marks every spike entity so they can be found and are clearly test data. */
export const SPIKE_APP = "trg-spike"

export function check(name: string, ok: boolean, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`)
  if (!ok) process.exitCode = 1
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

export async function balance(address: Hex) {
  const wei = await publicClient.getBalance({ address })
  return Number(wei) / 1e18
}
