# The root declares Alchemy's optional runtime peers

pnpm never auto-installs optional peer dependencies, yet `alchemy` and `@alchemy.run/cloudflare` load some of theirs at runtime: `alchemy dev` fails without `@effect/platform-bun`. So the root `package.json` declares those peers itself. It also declares `@alchemy.run/infisical`, which `alchemy profile` needs because it reads the manifests above the app folder. `.fallowrc.jsonc` lists them in `ignoreDependencies`.

Sites:
- `.fallowrc.jsonc`

Source: apinrdw/kumora#16, apinrdw/kumora#122
