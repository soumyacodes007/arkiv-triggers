/** Observe completed firing passes, independently of the heartbeat writer. */
export function watchProgress(
  readBlock: () => bigint,
  onStall: () => void,
  timeoutMs = 120_000,
  intervalMs = 5_000,
) {
  let seen = readBlock()
  let movedAt = Date.now()
  let stalled = false
  const healthy = () => !stalled && Date.now() - movedAt < timeoutMs
  const timer = setInterval(() => {
    const block = readBlock()
    if (block !== seen) [seen, movedAt] = [block, Date.now()]
    if (!healthy() && !stalled) {
      stalled = true
      onStall()
    }
  }, intervalMs)
  return { healthy, stop: () => clearInterval(timer) }
}
