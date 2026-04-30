// Type-only export surface for the app's `hc<AppType>()` client.
// Kept in its own module so the worker package's runtime imports
// (DocumentSyncRoom, the default export's `fetch`/`scheduled`) don't
// have to be re-exported alongside the type — `import type` from
// here is purely a compile-time relationship.
export type { AppType } from "./worker";
