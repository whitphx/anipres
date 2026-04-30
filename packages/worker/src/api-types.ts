// Type-only export surface for the app's `hc<AppType>()` client.
// Separated from `worker.ts` so the app `import type`s without
// pulling worker.ts's runtime exports into scope.
export type { AppType } from "./worker";
