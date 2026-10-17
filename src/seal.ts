// Sealing a Telegram chat ID (or any short secret) so only one worker can read it.
//
// Rules are public, so a chat ID never goes into one in plain text. Each worker derives an X25519
// key pair from its own wallet key and publishes the public half in its heartbeat. `sealForWorker`
// encrypts to that public key with a fresh ephemeral key (ECIES: X25519, HKDF-SHA256,
// XChaCha20-Poly1305); only the worker holding the private half can open it.

import { xchacha20poly1305 } from "@noble/ciphers/chacha.js"
import { randomBytes } from "@noble/ciphers/utils.js"
import { x25519 } from "@noble/curves/ed25519.js"
import { hkdf } from "@noble/hashes/hkdf.js"
import { sha256 } from "@noble/hashes/sha2.js"
import { bytesToHex, hexToBytes, type Hex } from "viem"
import { SEALED_PREFIX } from "./schema"

const enc = new TextEncoder()
const dec = new TextDecoder()
const INFO = enc.encode("arkiv-triggers/seal/v1")

export class SealError extends Error {}

/** A worker's sealing key pair, derived from its wallet key so it survives restarts with no extra secret. */
export function workerSealKeys(workerPrivateKey: Hex): { secretKey: Uint8Array; publicKey: Hex } {
  const secretKey = hkdf(sha256, hexToBytes(workerPrivateKey), enc.encode("arkiv-triggers/seal-key/v1"), enc.encode("x25519"), 32)
  return { secretKey, publicKey: bytesToHex(x25519.getPublicKey(secretKey)) }
}

function streamKey(shared: Uint8Array, ephemeralPublic: Uint8Array, recipientPublic: Uint8Array) {
  const salt = new Uint8Array(64)
  salt.set(ephemeralPublic, 0)
  salt.set(recipientPublic, 32)
  return hkdf(sha256, shared, salt, INFO, 32)
}

// base64url without Buffer, so sealing also works in the browser (the dashboard seals chat IDs).
const b64u = {
  encode: (b: Uint8Array) => {
    let s = ""
    for (const x of b) s += String.fromCharCode(x)
    return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
  },
  decode: (s: string) => {
    const t = s.replace(/-/g, "+").replace(/_/g, "/")
    const bin = atob(t + "=".repeat((4 - (t.length % 4)) % 4))
    return Uint8Array.from(bin, (c) => c.charCodeAt(0))
  },
}

/** Encrypts `text` so only the worker with this sealing public key (from its heartbeat) can read it. */
export function sealForWorker(text: string, workerSealKey: Hex): string {
  const recipient = hexToBytes(workerSealKey)
  if (recipient.length !== 32) throw new SealError("a worker sealing key is 32 bytes (0x + 64 hex characters)")
  const ephemeralSecret = randomBytes(32)
  const ephemeralPublic = x25519.getPublicKey(ephemeralSecret)
  const key = streamKey(x25519.getSharedSecret(ephemeralSecret, recipient), ephemeralPublic, recipient)
  const nonce = randomBytes(24)
  const ciphertext = xchacha20poly1305(key, nonce).encrypt(enc.encode(text))
  const out = new Uint8Array(32 + 24 + ciphertext.length)
  out.set(ephemeralPublic, 0)
  out.set(nonce, 32)
  out.set(ciphertext, 56)
  return SEALED_PREFIX + b64u.encode(out)
}

/** Opens a value sealed to this worker. Throws if it was sealed to another worker or tampered with. */
export function openSealed(sealed: string, workerPrivateKey: Hex): string {
  if (!sealed.startsWith(SEALED_PREFIX)) throw new SealError("not a sealed value")
  const raw = b64u.decode(sealed.slice(SEALED_PREFIX.length))
  if (raw.length < 56 + 16) throw new SealError("sealed value is too short")
  const { secretKey, publicKey } = workerSealKeys(workerPrivateKey)
  const ephemeralPublic = raw.slice(0, 32)
  const key = streamKey(x25519.getSharedSecret(secretKey, ephemeralPublic), ephemeralPublic, hexToBytes(publicKey))
  try {
    return dec.decode(xchacha20poly1305(key, raw.slice(32, 56)).decrypt(raw.slice(56)))
  } catch {
    throw new SealError("cannot open: sealed to a different worker, or tampered with")
  }
}
