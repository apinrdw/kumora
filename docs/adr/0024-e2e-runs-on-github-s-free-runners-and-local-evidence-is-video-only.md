# e2e runs on GitHub's free runners, and local evidence is video only

e2e left CI in apinrdw/kumora#209 because 6 shards on 2-core runners took 13+ minutes, so the dev machine ran the full suite and posted its video. The repo is now public, which makes Actions minutes free and the standard `ubuntu-latest` runner 4 cores. The full suite therefore runs in CI again, on that free runner, split into as many jobs as still cut wall time. A paid larger runner was rejected because the point of the move is that CI costs nothing. Playwright runs in full every project another one waits on, even under `--shard`, and `relay-load` and `repaint-bench` wait on all of them. So each job runs `setup` and the projects `E2E_PROJECTS` names, waiting on no other, and `chromium` and `trading-day` split further by `--shard`. A project on a machine of its own starts from empty stores, which is what waiting on `chromium` bought on one machine. The repaint bench stays off CI: its bar is set against the dev machine's CPU, and the free runner read 18.2 ms against its 16 ms. The jobs run on every ready PR that touches `apps/{web,dashboard,extension,e2e}` or `packages/`, with no retries. One always-running `e2e` summary job is the required check, so a skipped run never leaves it pending and a change to the shard count never touches the ruleset. `vp run e2e:evidence` keeps posting inline video, which only the author's own `gh` upload can do, but it now runs just `setup` and the named specs, each project narrowed to its picked files and waiting on no other. It no longer runs the full suite, because CI does. Its `e2e-evidence` status (ADR-0006) stays required beside `e2e`, and the two checks are independent of each other.

Sites:

- `.github/workflows/e2e.yml`
- `apps/e2e/playwright.config.ts`
- `apps/e2e/support/projects.ts`
- `scripts/e2e-evidence.mts`
- `scripts/workflow-deps.repo.test.mts`

Source: apinrdw/kumora#765
