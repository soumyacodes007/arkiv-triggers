import assert from "node:assert/strict"
import { test } from "node:test"
import { watchProgress } from "../src/progress"

test("a live heartbeat cannot keep a stalled firing loop healthy", (t) => {
  t.mock.timers.enable({ apis: ["Date", "setInterval"], now: 1_000 })
  let restarts = 0
  const monitor = watchProgress(() => 734228n, () => restarts++)
  t.after(() => monitor.stop())
  t.mock.timers.tick(119_999)
  assert.equal(monitor.healthy(), true)
  assert.equal(restarts, 0)
  t.mock.timers.tick(1)
  assert.equal(monitor.healthy(), false)
  assert.equal(restarts, 1)
  t.mock.timers.tick(120_000)
  assert.equal(restarts, 1, "request only one restart for this stalled process")
})

test("completed passes reset the deadline; stopping removes the watchdog", (t) => {
  t.mock.timers.enable({ apis: ["Date", "setInterval"], now: 1_000 })
  let block = 1n
  let restarts = 0
  const monitor = watchProgress(() => block, () => restarts++, 20_000, 1_000)
  t.mock.timers.tick(15_000)
  block = 2n
  t.mock.timers.tick(1_000)
  t.mock.timers.tick(19_000)
  assert.equal(monitor.healthy(), true)
  assert.equal(restarts, 0)
  monitor.stop()
  t.mock.timers.tick(60_000)
  assert.equal(restarts, 0)
})

test("startup is also bounded when no pass has completed", (t) => {
  t.mock.timers.enable({ apis: ["Date", "setInterval"], now: 1_000 })
  let restarts = 0
  const monitor = watchProgress(() => 0n, () => restarts++, 3_000, 1_000)
  t.after(() => monitor.stop())
  t.mock.timers.tick(3_000)
  assert.equal(monitor.healthy(), false)
  assert.equal(restarts, 1)
})
