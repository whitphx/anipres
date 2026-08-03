import { defineConfig } from "tsup";

// agent-core ships its workspace `exports` as `.ts` source. Inline it
// so `dist/bin.js` is runnable with plain `node` and doesn't need to
// resolve `.ts` files at runtime. Everything else (npm deps in
// node_modules, plus the built `anipres` library) stays external.
export default defineConfig({
  entry: ["src/bin.ts"],
  format: "esm",
  target: "es2022",
  outDir: "dist",
  clean: true,
  noExternal: ["@anipres/agent-core"],
  sourcemap: true,
});
