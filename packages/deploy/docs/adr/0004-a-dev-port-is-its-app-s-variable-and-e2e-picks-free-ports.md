# A dev port is its app's variable, and e2e picks free ports

An app's dev port is its app's variable, else the default. `apps/e2e/support/ports.ts` gives each e2e run free ports, so parallel worktrees need no lock; this beat fixed ports behind a machine-wide lock. Each port is strict, so a port taken between pick and bind fails the run loudly.

Sites:

- `packages/deploy/src/target.ts`

Source: apinrdw/kumora#194
