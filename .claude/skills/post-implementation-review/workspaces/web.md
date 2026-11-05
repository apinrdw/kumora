# web

Running the site and its probe locally, and checking prerender without a deploy.

- **Local run.** `ALCHEMY_STAGE=test DEPLOY_PROBE_SECRET=abc bun alchemy dev` from `apps/web` needs no Cloudflare or Infisical credential. `curl localhost:3000/probe` must answer `"secretSha256Prefix":"ba7816bf8f01"`, the SHA-256 prefix of `abc`.
- **Port 3000 taken by another project?** The port is strict, so the stack fails instead of moving. Run the server or `pnpm test:e2e` inside `unshare -rn sh -c 'ip link set lo up && ...'` for a private loopback.
- **Prerender without a deploy.** `alchemy deploy` needs credentials, but alchemy's build child runs alone. From `apps/web`, pipe a Bun-serialized config into it (Node's `v8.serialize` output fails in Bun with "Unable to deserialize data"):

  ```sh
  printf '%s\n' 'import { serialize } from "node:v8"; const { COMPATIBILITY_DATE } = await import(`${process.argv[2]}/../../packages/deploy/src/target.ts`); process.stdout.write(serialize({ rootDir: process.argv[2], env: {}, main: undefined, compatibilityDate: COMPATIBILITY_DATE, compatibilityFlags: ["nodejs_compat"], viteEnvironments: undefined, outputPath: "/tmp/web-build.bin" }))' > /tmp/web-build-config.mjs
  bun /tmp/web-build-config.mjs "$PWD" | bun ../../node_modules/.pnpm/@alchemy.run+cloudflare@2.0.0-beta.85*/node_modules/@alchemy.run/cloudflare/src/Workers/ViteBuildChildRunner.ts
  ```

  Pass: `[prerender] Prerendered 1 pages:` followed by `[prerender] - /`. Delete `dist/` afterwards. The config reads `COMPATIBILITY_DATE` from `packages/deploy/src/target.ts`.
- **Newest compatibility date the bundled workerd accepts.** Set `COMPATIBILITY_DATE` to a far-future date, run `bun alchemy dev`, and read "the newest date supported by this server binary" in the error. Put the date back.
- **A branch's Preview stage.** `bun packages/deploy/src/teardown.ts stage <branch>` from the root prints `stage=<stage>`; the Worker is `kumora-web-<stage>`.
