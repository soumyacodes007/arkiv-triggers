// Converting between dates and Arkiv blocks. Blocks come about every 2 seconds on Tiramisu, so a
// conversion is an estimate anchored on the chain's current block and its timestamp.

import { BLOCK_SECONDS } from "./schema"

/** A reference point from `arkiv_getBlockTiming` (or any block whose time is known). */
export type BlockClock = { block: bigint; timeMs: number; blockSeconds?: number }

/** The block expected at `date`. Rounded up, so a deadline is never earlier than asked. */
export function toBlock(date: Date | number, clock: BlockClock): bigint {
  const ms = typeof date === "number" ? date : date.getTime()
  const per = (clock.blockSeconds ?? BLOCK_SECONDS) * 1000
  const delta = Math.ceil((ms - clock.timeMs) / per)
  const b = clock.block + BigInt(delta)
  return b < 0n ? 0n : b
}

/** The time `block` is expected at (or happened at, for a past block). */
export function toDate(block: bigint, clock: BlockClock): Date {
  const per = (clock.blockSeconds ?? BLOCK_SECONDS) * 1000
  return new Date(clock.timeMs + Number(block - clock.block) * per)
}
