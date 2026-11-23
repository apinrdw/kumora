# Secrets are read from Infisical at deploy

A stack reads its secrets from Infisical at deploy and binds them as `secret_text`, so a rotated secret goes live on the next deploy. This supersedes syncing Infisical into Cloudflare. Cloudflare Secrets Store waits until a secret must rotate without a deploy.

Sites:
- `packages/deploy/src/stack.ts`

Source: apinrdw/kumora#18
