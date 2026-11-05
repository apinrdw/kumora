<p align="center"><img src="apps/web/public/og-image.jpg" alt="KUMORA AI, follow the smart money" width="600"></p>

# KUMORA

A market terminal for the Indonesian stock exchange, built as a pnpm + Turborepo monorepo on TanStack Start and shadcn/ui.

## Workspaces

| Workspace        | Package         | Purpose                                                                                                                             |
| ---------------- | --------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `apps/dashboard` | `dashboard`     | The terminal. Only its shell today, with no pages. Port 3001 in dev. |
| `apps/web`       | `web`           | Public site. Still the starter landing page. Port 3000 in dev.                                                                      |
| `apps/e2e`       | `e2e`           | Playwright smoke tests. Starts both apps with dummy values, so no secret is needed.                                                 |
| `packages/ui`    | `@workspace/ui` | Shared shadcn/ui components, hooks, and Tailwind styles consumed by both apps.                                                      |

## Commands

Run from the repo root. Each fans out through Turborepo to every workspace.

```bash
pnpm dev        # start both apps
pnpm typecheck
pnpm lint
pnpm test
pnpm build
pnpm test:e2e  # first run: pnpm --filter e2e exec playwright install chromium
```

CI runs typecheck, lint, test, and the E2E suite on every pull request and push to `main`.

## Adding UI components

Run from the repo root. Components land in `packages/ui/src/components`.

```bash
pnpm dlx shadcn@latest add button -c apps/web
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
- Decisions are `Decision:` comments next to the code they constrain (`rg 'Decision:'`). The repo keeps no ADRs.
