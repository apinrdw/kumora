# The Worker hashes passwords with Better Auth's scrypt

The Worker passes no password hasher, so it hashes with Better Auth's scrypt. The test seam passes a fast stand-in, since scrypt costs about 57 ms per sign-up; `handler.test.ts` keeps one test on scrypt so the real path stays covered.

Sites:

- `apps/dashboard/src/server/auth/options.ts`

Source: apinrdw/kumora#171
