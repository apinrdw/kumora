# Effect and Alchemy pins live once in the catalog

The `effect` and `alchemy` versions are pinned once, in the `pnpm-workspace.yaml` catalog. Two Effect copies break `Context.Service` and `Schema.TaggedError` identity, and `repos/effect` and `repos/alchemy` are subtrees of these exact versions, so a bump here also runs the subtree pull that `AGENTS.md` describes. `catalogMode` only governs `pnpm add`, so `scripts/catalog-pins.repo.test.mts` rejects any non-catalog specifier for these packages.

Sites:
- `pnpm-workspace.yaml`

Source: none
