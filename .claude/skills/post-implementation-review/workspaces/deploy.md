# deploy

Checking the stacks, the deploy script and the Workers Builds side without deploying.

- **Plan a stage without deploying.** With a profile holding Cloudflare and Infisical (runbook step 6), `bun alchemy plan --stage <stage> --no-input` from `apps/web` or `apps/dashboard` loads the stage's state and Infisical secrets and prints what a deploy would do. It changes nothing. Get a branch's Preview stage from `bun packages/deploy/src/teardown.ts stage <branch>`.
- **`alchemy profile edit` evaluates the stacks.** It runs them with alchemy's `PLACEHOLDER_STAGE` to discover auth providers, so a stack change that rejects that stage breaks profile setup with "Could not load auth providers from 'alchemy.run.ts'". `packages/deploy/tests/stack.test.ts` covers it. `--no-input` reaching "Cannot run selection without an interactive terminal" means discovery passed.
- **Workers Builds logs need the owner.** The API for build logs needs a token with Workers Builds read, which the deploy tokens lack, so ask the owner to paste the failed build's log. A failure at "Cloning repository... error occurred while updating repository submodules" is a submodule entry in the index; `node scripts/check-no-gitlinks.mts` names it.
- **Use the pinned fallow.** `pnpm exec fallow audit --base origin/main`, not a `fallow` on `PATH`: CI's `fallow` job runs the pinned version, and an older global one missed findings it reports.
