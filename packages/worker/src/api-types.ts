// Separated from `worker.ts` so the app can `import type` the route
// signature without pulling worker.ts's runtime exports into scope.
export type { AppType } from "./worker";
