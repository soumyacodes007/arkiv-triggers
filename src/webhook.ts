// Signed webhooks. A worker signs every webhook body with its wallet key (EIP-191), and a receiver
// checks the signer against the worker addresses it trusts. The signature travels in `x-trg-sig`.

import { type Hex, isAddressEqual, recoverMessageAddress } from "viem"

export const WEBHOOK_HEADERS = {
  signature: "x-trg-sig",
  worker: "x-trg-worker",
  rule: "x-trg-rule",
  /** The same for every retry of one firing, so receivers can drop duplicates. */
  event: "x-trg-event",
} as const

/** What a worker POSTs. `test` is true only for "Send test" messages from the dashboard or CLI. */
export type WebhookBody = {
  event: string
  rule: Hex
  ruleName?: string
  trigger: "expire" | "block"
  target?: Hex
  deadline: string
  firedAt: string
  message?: string
  worker: Hex
  test?: boolean
}

export type VerifyResult = { ok: true; worker: Hex } | { ok: false; reason: string }

/**
 * Checks that `body` (the raw request text, exactly as received) was signed by one of the trusted
 * workers. Parse the JSON only after this returns ok.
 */
export async function verifyWebhook(body: string, signature: string | null | undefined, trusted: readonly Hex[]): Promise<VerifyResult> {
  if (!signature) return { ok: false, reason: `missing ${WEBHOOK_HEADERS.signature} header` }
  let signer: Hex
  try {
    signer = await recoverMessageAddress({ message: body, signature: signature as Hex })
  } catch {
    return { ok: false, reason: "malformed signature" }
  }
  if (!trusted.some((t) => isAddressEqual(t, signer))) return { ok: false, reason: `signed by ${signer}, which is not a trusted worker` }
  return { ok: true, worker: signer }
}
