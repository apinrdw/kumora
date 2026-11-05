# Deploy runbook

The one-time and yearly steps a human does for the Alchemy deploys. Agents skip this file. The code side is in `packages/deploy` and `.github/workflows/teardown-preview.yml`; the stage names are defined in `packages/deploy/GLOSSARY.md`.

Run `scripts/deploy-setup.sh` from a PR branch to be walked through every ⬜ step below, then the stage check (step 8) against that branch's Preview. It writes no secret to a file.

Steps marked ✅ were done during the throwaway deploy, observed 2026-11-05 ([apinrdw/kumora#20](https://github.com/apinrdw/kumora/issues/20)). Steps marked ⬜ are still to do.

## 1. Infisical project ✅

- Project slug `kumora`, environments `prod` and `staging`. ⬜ Delete the unused `dev` environment.
- `/` in each environment holds `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`, with a separate token per environment.
- `/web` holds `DEPLOY_PROBE_SECRET`. `/dashboard` holds the dashboard's secrets, none today.
- Machine identity `kumora-workers-builds`: viewer role, Universal Auth, client secret with a 1-year TTL.

## 2. Cloudflare API tokens ✅

One token per Infisical environment, stored at `/` of that environment. As observed 2026-11-05, deploy and destroy work with Alchemy's 9-permission CI policy: Workers Scripts, KV, R2, D1, Queues, Pages, Account Settings and Secrets Store Write, plus Workers Tail Read.

As observed 2026-11-05, both tokens are **user** tokens with no expiry. ⬜ Replace each with an **account** token with the same permissions and a 1-year TTL. The dashboard path Manage Account → Account API Tokens → Create Token is unverified. Paste it over `CLOUDFLARE_API_TOKEN` at `/` of its environment. Record the minimal scope here once it is measured.

## 3. State store ✅

Bootstrapped once from a personal profile with `bun alchemy state bootstrap --backend cloudflare`. Its Worker is `alchemy-state-store`. Production, Staging and every Preview share it; Dev and Test stages keep local state in `.alchemy/`.

## 4. Workers Builds connections

One connection per app, each on a hand-made anchor Worker that Alchemy never deploys.

| Setting | `kumora-web-builds` | `kumora-dashboard-builds` |
| --- | --- | --- |
| Status | ✅ created and connected | ⬜ create and connect the same way |
| Root directory | `apps/web` | `apps/dashboard` |
| Watch paths | `apps/web/**`, `packages/**` | `apps/dashboard/**`, `packages/**` |
| Production branch | `main` | `main` |
| Non-production branch builds | on | on |
| Deploy command | ⬜ `bun ../../packages/deploy/src/deploy.ts web` | ⬜ `bun ../../packages/deploy/src/deploy.ts dashboard` |
| Preview command | ⬜ same as the deploy command | ⬜ same as the deploy command |
| Build variables | `INFISICAL_CLIENT_ID`, `INFISICAL_CLIENT_SECRET` (secret), ⬜ `BUN_VERSION=1.4.4` | the same |

Leave the build command empty: as observed 2026-11-05, Workers Builds already runs `pnpm install --frozen-lockfile` at the repo root before the deploy command. `BUN_VERSION` must match `.bun-version`; change both together.

As observed 2026-11-05, every push to `main` fails the `kumora-web-builds` check until this spec merges, because `main` has no deploy script. Pause that connection's builds or ignore the check.

## 5. GitHub teardown identity ⬜

1. In Infisical, create machine identity `kumora-github-teardown` with **OIDC Auth**: discovery URL `https://token.actions.githubusercontent.com`, issuer `https://token.actions.githubusercontent.com`, subject `repo:apinrdw/kumora:*`, audience `https://github.com/apinrdw` (GitHub's default, since the job requests none). These Infisical field names are unverified.
2. Give it read access to the `staging` environment only. Whether Infisical can scope an identity to one environment is unverified.
3. In GitHub, Settings → Secrets and variables → Actions → **Variables** (an unverified path), add `INFISICAL_TEARDOWN_IDENTITY_ID` with the identity's ID. It is a variable, not a secret: the ID alone grants nothing.

## 6. Developer profiles ⬜

Each developer runs, from either app's folder:

```sh
bun alchemy profile edit --add Cloudflare
bun alchemy profile edit --add Infisical
```

`pnpm dev` then runs both apps on the developer's Dev stage, with secrets from Infisical `staging`.

## 7. Yearly rotation

- The `kumora-workers-builds` Universal Auth client secret: create a new one in Infisical, paste it into `INFISICAL_CLIENT_SECRET` on **both** anchor Workers, then revoke the old one.
- Both Cloudflare tokens (step 2): rotate in Cloudflare and update them in Infisical only. The next deploy of each stage picks them up.

## 8. Checking a stage

```sh
curl https://<worker-name>.kumora.workers.dev/probe
```

The Worker name is `kumora-<app>` for Production and `kumora-<app>-<stage>` otherwise; `bun packages/deploy/src/teardown.ts stage <branch>` prints a branch's Preview stage. The answer must show `"secretPresent": true`, and `secretSha256Prefix` must equal the first 12 hex digits (`SHA256_PREFIX_LENGTH` in `apps/web/src/server/probe.ts`) of the SHA-256 of the `DEPLOY_PROBE_SECRET` in that Stage's Infisical environment:

```sh
printf '%s' "$value" | sha256sum | cut -c1-12
```
