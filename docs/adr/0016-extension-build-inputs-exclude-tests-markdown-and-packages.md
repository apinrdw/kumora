# Extension build inputs exclude tests, Markdown and packages

A change to the extension's build inputs requires a `version` bump. Every file under `apps/extension` counts as a build input except its `tests/`, any `*.md`, and `vitest.config.ts`, which `vite build` never reads; `tsconfig.json` stays in because vite resolves imports through it. The workspace packages the extension imports (relay, ui, deploy) are out: watching them would demand a bump for every dashboard-only change to `packages/ui`.

Sites:

- `scripts/extension-version.mts`

Source: none
