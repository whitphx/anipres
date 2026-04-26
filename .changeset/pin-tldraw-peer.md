---
"anipres": patch
---

Tighten the `tldraw` peer dependency from `^3.15.5` to exact `3.15.5`. Anipres' shape schemas are now shared across the editor and the new `anipres/schema` subpath; minor tldraw versions can change shape internals, so pinning keeps the contract stable. Consumers should align their own `tldraw` install to the same exact version.
