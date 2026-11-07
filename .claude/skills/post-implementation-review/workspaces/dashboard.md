# dashboard

Driving the shell in a real browser.

- **Stop servers by port with `fuser -k 3001/tcp`.** A `pkill -f` pattern that also appears later in the same shell command kills that shell, with exit 144.
- **Every page sits behind the sign-in gate.** Signed out, `curl -sS -o /dev/null -w '%{http_code} %{redirect_url}' <url>/` answers `307 …/sign-in?redirect=%2F`; that is the quickest check that a stage serves the gate (a Preview too). Signed in, `/` is still the not-found page inside the shell until Market Live exists.
- **The Test stage needs `ADMIN_EMAILS` in the process environment.** `ALCHEMY_STAGE=test ADMIN_EMAILS=admin@example.com bun alchemy dev` runs with no Cloudflare or Infisical credential; `pnpm test:e2e` sets it for you. The Dev stage (`pnpm dev`) reads it from Infisical `staging` and fails until it is there.
- **Mail lands as `.eml` files** under `apps/dashboard/.alchemy/local/email`, newest last; the links in them are the only way to verify an account locally.
- **Turnstile's iframe isn't reachable by selector.** On 2026-11-07, `iframe[src*="challenges.cloudflare.com"]` matched nothing on `/sign-up` (probably a shadow root, not confirmed); check instead that the form's request to `/api/auth/sign-up/email` carries an `x-captcha-response` header (Turnstile's test keys pass every token).
- **Plant a defect against the handler seam.** `pnpm exec vitest run tests/server/auth/<file>.test.ts` from `apps/dashboard` runs real Better Auth over SQLite in seconds; most auth fixes are covered there, not only in e2e.
- **Port 3000 or 3001 taken by another project?** Both dev ports are strict. Run the servers or `pnpm test:e2e` inside `unshare -rn sh -c 'ip link set lo up && ...'` for a private loopback.
