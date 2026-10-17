import { defineConfig } from "tsup"

// One build for all three entries. src/cli.ts starts with a #! line, which esbuild keeps.
export default defineConfig({
  entry: { index: "src/index.ts", worker: "src/worker.ts", cli: "src/cli.ts" },
  format: ["esm"],
  target: "node22",
  dts: { entry: { index: "src/index.ts", worker: "src/worker.ts" } },
  clean: true,
  sourcemap: false,
})
