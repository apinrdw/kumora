# The waitlist gets its own D1, kept on destroy only in Production

The landing page's waitlist holds the emails visitors leave and their queue numbers. It is the first data `apps/web` stores, so it gets a D1 database of its own, WaitlistDb, bound as `WAITLIST_DB` with its own migrations in `apps/web/waitlist-migrations/`. It shares nothing with the dashboard's databases, so either app can be reset or redeployed without the other. As every dashboard D1 does (`apps/dashboard/docs/adr/0124-every-d1-is-recreated-in-apac-by-cloning-the-one-it-replaces.md`), it carries `primaryLocationHint: "apac"` on every stage, because requests are served from Singapore. The hint is set from its first deploy, so it never needs a clone. Read replication stays off, Alchemy's default.

Production's WaitlistDb is retained (`RemovalPolicy.retain`) across a stack destroy, as the dashboard's ArchiveDb is (`apps/dashboard/docs/adr/0126-only-production-s-archivedb-survives-a-stack-destroy.md`). Its rows cannot be rebuilt: each is a visitor who signed up, and their queue number was shown to them. Every other stage's WaitlistDb is test data and is destroyed with its stack, so a closed Preview leaves nothing behind.

Sites:

- `apps/web/alchemy.run.ts`

Source: none
