// Every workspace's vitest.config.ts takes its default test timeout from here.
// Decision: the dev machine's test timeout is half of CI's 5 s
// (docs/adr/0019-the-dev-machine-s-test-timeout-is-half-of-ci-s.md)
export const testTimeout = process.env.CI ? 5_000 : 2_500
