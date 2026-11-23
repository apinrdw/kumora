# Apps deploy as Workers through Workers Builds running Alchemy

The apps deploy as Cloudflare Workers with static assets, built and deployed by Workers Builds running Alchemy. Pages lost because Cloudflare steers new projects to Workers. Deploying from GitHub Actions lost because it would need Cloudflare and Infisical credentials in CI.

Sites:
- `packages/deploy/src/stack.ts`

Source: apinrdw/kumora-monorepo#18, apinrdw/kumora#17
