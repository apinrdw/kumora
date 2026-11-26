# vite-plus is the one Oxc pin

Oxlint minors add rules and change defaults without calling it breaking, so the linter and formatter must not move unannounced. `vite-plus` is an exact root devDependency, and the Oxlint, `@oxlint/plugins` and Oxfmt versions it pins are the repo's only copies: the root `oxlint` and `oxfmt` devDependencies are gone, because `vp lint` and `vp fmt` prefer a local copy over their own (vite-plus#3065). Lint and format rules live in the `lint` and `fmt` blocks of the root `vite.config.ts`; plain `oxlint` and `oxfmt` don't read it, so every lint and format call goes through `vp`. `vite-plus` moves only through one grouped Dependabot PR, and Dependabot's `allow` limits version updates to it. It supersedes ADR-0003, which pinned `oxlint` and `oxfmt` themselves.

Sites:

- `.github/dependabot.yml`
- `vite.config.ts`

Source: apinrdw/kumora#724
