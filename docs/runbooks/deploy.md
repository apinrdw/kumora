# Deploy runbook

The one-time and yearly steps a human does for the Alchemy deploys. Agents skip this file. The code side is in `packages/deploy` and `.github/workflows/teardown-preview.yml`; the stage names are defined in `packages/deploy/GLOSSARY.md`.

Run `scripts/deploy-setup.sh` from a PR branch to be walked through every ⬜ step below, then the stage check (step 8) against that branch's Preview. It writes no secret to a file.

Steps marked ✅ were done during the throwaway deploy, observed 2026-11-05 ([apinrdw/kumora#20](https://github.com/apinrdw/kumora/issues/20)). Steps marked ⬜ are still to do.

## 1. Infisical project ✅

- Project slug `kumora`, environments `prod` and `staging`. A `dev` environment also exists; it is unused and stays empty. Local dev (the Dev stage) reads `staging`, so don't put secrets in `dev`.
- `/` in each environment holds `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`, with a separate token per environment.
- `/web` holds `DEPLOY_PROBE_SECRET`. `/dashboard` holds the dashboard's secrets, none today.
- Machine identity `kumora-workers-builds`: Universal Auth only, client secret with a 1-year TTL, project `kumora` role Viewer. Organization role **No Access**, set 2026-11-05 (it was Admin, which let every branch build manage the whole Infisical organization); the owner reported the next build succeeding.

## 2. Cloudflare API tokens ✅

One token per Infisical environment, stored at `/` of that environment. As observed 2026-11-05, deploy and destroy work with Alchemy's 9-permission CI policy: Workers Scripts, KV, R2, D1, Queues, Pages, Account Settings and Secrets Store Write, plus Workers Tail Read.

As of 2026-11-05, both are **account** tokens (prefix `cfat_`) under Manage Account → Account API Tokens, and the earlier user tokens are deleted. Whether they carry a 1-year TTL is unconfirmed; give the next pair one. Each sits in `CLOUDFLARE_API_TOKEN` at `/` of its environment. Record the minimal scope here once it is measured.

## 3. State store ✅

Bootstrapped once from a personal profile with `bun alchemy state bootstrap --backend cloudflare`. Its Worker is `alchemy-state-store`. Production, Staging and every Preview share it; Dev and Test stages keep local state in `.alchemy/`.

## 4. Workers Builds connections

One connection per app, each on a hand-made anchor Worker that Alchemy never deploys. As observed 2026-11-05, both deployed this spec's PR (#33) to its Preview, and `/probe` answered the `staging` hash prefix.

| Setting | `kumora-web-builds` | `kumora-dashboard-builds` |
| --- | --- | --- |
| Status | ✅ created and connected | ✅ created and connected |
| Root directory | `apps/web` | `apps/dashboard` |
| Watch paths | `apps/web/**`, `packages/**`, `pnpm-lock.yaml`, `pnpm-workspace.yaml`, `package.json`, `.bun-version` | `apps/dashboard/**`, `packages/**`, and the same four root files |
| Production branch | `main` | `main` |
| Non-production branch builds | on | on |
| Deploy command | ✅ `bun ../../packages/deploy/src/deploy.ts web` | ✅ `bun ../../packages/deploy/src/deploy.ts dashboard` |
| Version command (non-production branches) | ✅ same as the deploy command | ✅ same as the deploy command |
| Build variables | `INFISICAL_CLIENT_ID`, `INFISICAL_CLIENT_SECRET` (secret), `BUN_VERSION` set to the version in `.bun-version` | the same |

As observed 2026-11-05 in the dashboard's Build configuration panel, the preview command is the field named **Version command**, beside Build command, Deploy command and Root directory. Leave the build command empty: as observed 2026-11-05, Workers Builds already runs `pnpm install --frozen-lockfile` at the repo root before the deploy command. `BUN_VERSION` must match `.bun-version`; change both together.

The four root files in Watch paths are every app's dependency inputs, so a lockfile or catalog change alone still deploys; `ROOT_WATCH_PATHS` in `scripts/deploy-setup.sh` lists the same files. The owner set them on both connections on 2026-11-05 as a comma-separated list; the first dependency-only commit is what confirms the field took them.

As observed 2026-11-05, every push to `main` fails the `kumora-web-builds` check until this spec merges, because `main` has no deploy script. Pause that connection's builds or ignore the check.

## 5. GitHub teardown identity ✅

1. In Infisical, create machine identity `kumora-github-teardown`, separate from `kumora-workers-builds`, with organization role **No Access** (as observed 2026-11-05, the roles offered are Admin, Member and No Access). Add the **OIDC Auth** method. As observed 2026-11-05 in its Add Auth Method form (Configuration: Custom Configuration), set OIDC Discovery URL and Issuer both to `https://token.actions.githubusercontent.com`, Audiences to `https://github.com/apinrdw` (GitHub's default, since the job requests none), and Access Token TTL and Max TTL to `1800` (the job times out at 15 minutes). Leave Subject empty and use **Add Claims** for `repository` = `apinrdw/kumora`: a closed PR's token has subject `repo:apinrdw/kumora:pull_request` and a deleted branch's has `repo:apinrdw/kumora:ref:refs/heads/main`, and as observed 2026-11-05 Infisical rejected the subject `repo:apinrdw/kumora:*` with "OIDC subject not allowed". The Add Claims form itself is unverified.
2. Add it to project `kumora` as **Viewer**. As observed 2026-11-05, this setup destroyed PR #33's two Preview Workers when the PR closed. As observed 2026-11-05, roles limited to one environment need custom roles, which are a paid Infisical feature, so it can read `prod` too. This is an accepted risk, like the Workers Builds identity's; revisit with a paid plan or outside contributors.
3. In GitHub, Settings → Secrets and variables → Actions → **Variables** (an unverified path), add `INFISICAL_TEARDOWN_IDENTITY_ID` with the identity's ID. It is a variable, not a secret: the ID alone grants nothing.

## 6. Developer profiles

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

## 9. Dashboard auth mail ⬜

The dashboard sends verification mail from `no-reply@mailer.pusat.ai` through Cloudflare Email Sending. Production alone owns the `mailer.pusat.ai` sending subdomain (`apps/dashboard/alchemy.run.ts`); every other stage only binds to it.

1. **Deploy Production with auth first.** Until Production has deployed the subdomain, mail from Staging and every Preview fails (the sign-up still succeeds; the send is logged as failed). Dev and Test stages never send: they write `.eml` files under `apps/dashboard/.alchemy/local/email`.
2. Before that deploy, give the `prod` Cloudflare token (step 2) Zone Read and Email Sending Edit on the `pusat.ai` zone. The stack looks the zone up by name and fails the deploy if it is missing.
3. If `mailer.pusat.ai` already exists under Email Sending, Alchemy reports it as not owned and refuses it. Delete it first, or run that one Production deploy with `--adopt`.
4. Check by hand on a Preview: sign up with an address you can read through `POST https://<worker-name>.kumora.workers.dev/api/auth/sign-up/email` with body `{"email":"…","password":"…","name":"…"}`, an `Origin` header of the same `https://<worker-name>.kumora.workers.dev`, and an `x-captcha-response: XXXX.DUMMY.TOKEN.XXXX` header (a Preview uses Turnstile's always-pass test keys, which accept any token), receive the mail, and open its link. It must redirect to `/`.

## 10. Dashboard Turnstile ⬜

Create account and Send reset link carry a Turnstile widget. Production and Staging each own one, a `Cloudflare.Turnstile.Widget` for their own workers.dev hostname in `apps/dashboard/alchemy.run.ts`; Previews, Dev and Test stages use Cloudflare's always-pass test keys and own none.

1. Before the first Production and Staging deploys with auth, give both the `prod` and the `staging` Cloudflare tokens (step 2) **Turnstile Sites Write** on the account. Step 2's policy lacks it, so until then the deploy fails creating the widget. Previews need nothing new.
2. After each deploy, check the widget exists under Turnstile in the Cloudflare dashboard with the stage's hostname, and that Create account on that stage shows it.

The auth routes are also rate-limited per client IP in the stage's D1 (sign-in 10 per minute, sign-up 5 per hour, resend verification and reset request 3 per hour), and each address gets at most 5 verification or reset mails a day. Nothing to set up: the tables come with the D1 migrations.
