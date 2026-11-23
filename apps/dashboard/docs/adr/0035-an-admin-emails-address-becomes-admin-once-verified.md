# An ADMIN_EMAILS address becomes admin once verified

An email on `ADMIN_EMAILS` becomes admin once it is verified, not when the account is created, so nobody can squat an admin email before its owner signs up. The promotion runs after every write of an account; from then on the role lives in the database. An email listed after it was verified is a config admin at once (`session-account.ts`).

Sites:
- `apps/dashboard/src/server/auth/callbacks.ts`

Source: apinrdw/kumora#70
