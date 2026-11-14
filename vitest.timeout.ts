// Every workspace's vitest.config.ts takes its default test timeout from here.
// Decision: half of CI's 5 s on the dev machine, because CI's 2 cores run a
// test about twice as slow. Spec #244's Ajaib walk tests took about 3 s here
// and passed, even under `taskset -c 0,1`, then timed out on CI. A test that
// is slow on purpose sets its own timeout. turbo passes CI through to tests.
export const testTimeout = process.env.CI ? 5_000 : 2_500
