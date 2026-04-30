---
"anipres": minor
---

ESM-only — drop the CJS build.

The package now ships only an ESM build. The `./schema` subpath was already ESM-only (no `require` branch in `exports`) since it was added; consolidating the main entry to match.

Drops from `package.json`:

- `main` field (was the `.cjs` artifact)
- `module` field (redundant now that `exports` is the single source)
- The `require` branch in `exports."."`

The `vite.config.ts` lib config now pins `formats: ["es"]` so vite stops emitting `.cjs` outputs alongside the ESM ones.

This is a breaking change for consumers using `require("anipres")` from a CJS context. ESM consumers (the dominant pattern in modern React tooling — Vite, Next.js 13+, Webpack 5+, Cloudflare Workers, etc.) are unaffected. Internal consumers in this repo (`packages/app` via Vite, `packages/worker` via workerd) already use ESM.
