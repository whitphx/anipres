---
"anipres": major
---

Replace dense animation indices and sub-frame links with stable step identities and fractional order keys. Existing v1 animation metadata is migrated deterministically, mixed v1/v2 snapshots remain readable during rollout, and the legacy frame types remain available from `anipres/models` for transition tooling.
