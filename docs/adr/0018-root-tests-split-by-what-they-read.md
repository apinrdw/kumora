# Root tests split by what they read

The root tests split into turbo tasks by what they read, so a workflow or lockfile edit reruns only the `*.repo.test.mts` files that read live repo config, and other root tests replay from cache. `scripts/root-test-inputs.repo.test.mts` checks that each task's inputs cover the files its tests read.

Sites:
- `turbo.json`

Source: apinrdw/kumora#170
