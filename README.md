<p align="center"><img src="apps/web/public/og-image.jpg" alt="KUMORA AI, follow the smart money" width="600"></p>

# KUMORA

A market terminal for the Indonesian stock exchange, built as a pnpm + Turborepo monorepo on TanStack Start and shadcn/ui.

## Workspaces

| Workspace         | Package             | Purpose                                                                                          |
| ----------------- | ------------------- | ------------------------------------------------------------------------------------------------ |
| `apps/dashboard`  | `dashboard`         | The terminal. Only its shell today, with no pages. Port 3001 in dev.                             |
| `apps/web`        | `web`               | Public site. Still the starter landing page. Port 3000 in dev.                                   |
| `apps/e2e`        | `e2e`               | Playwright smoke tests. Starts both apps with dummy values, so no secret is needed.              |
| `packages/deploy` | `@workspace/deploy` | Branch to stage, Worker names, the Alchemy stack options, and the deploy and teardown scripts.   |
| `packages/server` | `@workspace/server` | The Effect bridge server functions run through: `runServerEffect`, `WorkerEnv`, the HTTP errors. |
| `packages/ui`     | `@workspace/ui`     | Shared shadcn/ui components, hooks, and Tailwind styles consumed by both apps.                   |

## Commands

Run from the repo root. Each fans out through Turborepo to every workspace.

```bash
vp run dev        # start both apps with `bun alchemy dev` (needs Bun, see .bun-version)
vp run typecheck
vp run lint
vp run test
vp run test:e2e  # first run: vp exec --filter e2e playwright install chromium
```

CI runs typecheck, lint and test on every pull request and push to `main` or `staging`. The E2E suite runs on your machine: `vp run e2e:evidence <spec...>` runs it, posts the named specs' videos to the PR and sets its `e2e-evidence` status (rules in `scripts/e2e-evidence-plan.mts`). `.github/workflows/e2e-evidence.yml` sets that status on PRs that have none. Workers Builds deploys each push: `main` to production, `staging` to staging, any other branch to a preview. PRs target `staging`, the default branch, and reach `main` when the owner publishes a GitHub Release on a tried `staging` commit, which fast-forwards it. See `docs/runbooks/deploy.md`; `scripts/deploy-setup.sh` walks through its one-time steps.

## Adding UI components

Run from the repo root. Components land in `packages/ui/src/components`.

```bash
vp dlx shadcn@latest add button -c apps/web
```

Import them from the shared package:

```tsx
import { Button } from "@workspace/ui/components/button"
```

## Brand assets

The logo sources are `assets/brand/kumora-icon.png` (the square app icon) and `assets/brand/kumora-wordmark.png` (the icon with the KUMORA AI wordmark, on a transparent background). Every favicon, PWA icon, header logo and the Open Graph image is generated from them. After you replace a source, regenerate the outputs and commit them:

```sh
python3 -I scripts/brand-assets.py
```

The script needs Pillow built with libimagequant (`python3-pil` on Debian and Ubuntu).

## Agent and contributor docs

- `AGENTS.md` points agents at the issue tracker, triage labels, and domain docs under `docs/agents/`.
- `GLOSSARY-MAP.md` indexes per-workspace glossaries.
- A decision whose undoing reaches beyond its line is an ADR in its context's `docs/adr/`, with a `Decision:` pointer at each line it constrains (`rg 'Decision:'`). See `docs/agents/domain.md`.

## License

[MIT](LICENSE). The vendored copies under `repos/` keep their own licenses.
