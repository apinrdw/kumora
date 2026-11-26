# The dev machine's test timeout is half of CI's

CI's 2 cores run a test about twice as slow as the dev machine, so the dev machine's test timeout is half of CI's 5 s. Spec apinrdw/kumora#244's Ajaib walk tests took about 3 s locally and passed, even under `taskset -c 0,1`, then timed out on CI. A test that is slow on purpose sets its own timeout, and turbo passes the CI variable through to tests.

Sites:

- `vitest.timeout.mts`

Source: apinrdw/kumora#244
