import { defineConfig } from "tsup";

export default defineConfig([
  {
    entry: ["src/index.ts"],
    outDir: "dist",
    format: ["esm"],
    dts: true,
    sourcemap: true,
    target: "node20",
    clean: true,
  },
  {
    entry: ["src/cli/index.ts"],
    outDir: "dist/cli",
    format: ["esm"],
    sourcemap: true,
    target: "node20",
    banner: { js: "#!/usr/bin/env node" },
  },
]);
