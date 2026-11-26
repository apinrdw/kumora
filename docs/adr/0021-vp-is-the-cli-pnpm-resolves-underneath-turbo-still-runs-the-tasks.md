# vp is the CLI; pnpm resolves underneath; turbo still runs the tasks

Contributors, agents, CI, Workers Builds and the pre-commit hook call Vite+'s `vp` for package work: `vp install`, `vp add`, `vp exec`, `vp dlx`, `--filter` and running root scripts with `vp run`. One front door replaces switching between pnpm, oxlint, oxfmt and tsc commands. pnpm stays the package manager underneath: `vp install` forwards to the `packageManager` pnpm, so the lockfile, `pnpm-workspace.yaml`, the catalog (ADR-0015) and the build approvals are unchanged. turbo still runs the tasks, with its GitHub Actions cache (ADR-0005), because vite-plus 1.8's own runner has no remote cache, does not reliably cache Vitest or TypeScript tasks (vite-task#929) and misses its cache at other checkout paths such as t3 worktrees (vite-plus#3374); `vp run` starts a root script with its cache off, and turbo inside it caches as before. `vite-plus` is an exact root devDependency, and each CI job is set up by one `voidzero-dev/setup-vp` step pinned to a commit, naming the same vp version. Both apps' Workers Builds install with that vp version too, through `packages/deploy/workers-builds-install.sh`. `scripts/check-vp-version.mts` fails `check:static` when either names another version. Tests stay on plain `vitest run`, since `vp test` resolves its own bundled Vitest first. ADR-0011 deferred Vite Plus because it re-aliases `vite` and adds a second task runner; neither happens here, since no `vite` alias is installed and turbo stays the one runner.

Sites:

- `.github/workflows/ci.yml`
- `.github/workflows/release.yml`
- `.github/workflows/teardown-preview.yml`
- `packages/deploy/workers-builds-install.sh`
- `scripts/vp-version.mts`

Source: apinrdw/kumora#721
