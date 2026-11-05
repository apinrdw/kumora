# dashboard

Driving the shell in a real browser.

- **Stop servers by port with `fuser -k 3001/tcp`.** A `pkill -f` pattern that also appears later in the same shell command kills that shell, with exit 144.
- **`/` answers 404 until a page exists.** With only `__root`, every path renders the shell around the root not-found message, so `curl -I localhost:3001/` shows 404, and the browser logs one "Failed to load resource" console error for the document itself.
- **No secrets are needed.** Its stack binds none, so `ALCHEMY_STAGE=test bun alchemy dev` runs with no Cloudflare or Infisical credential.
- **Port 3000 or 3001 taken by another project?** Both dev ports are strict. Run the servers or `pnpm test:e2e` inside `unshare -rn sh -c 'ip link set lo up && ...'` for a private loopback.
