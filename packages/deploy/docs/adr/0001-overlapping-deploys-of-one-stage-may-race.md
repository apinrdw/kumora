# Overlapping deploys of one stage may race

Workers Builds runs two builds of one branch in parallel, and the Alchemy state store has no lock, so overlapping deploys of one stage can race. The risk is accepted rather than guarded against; revisit it if overlapping deploys cause trouble.

Sites:

- `packages/deploy/src/deploy-command.ts`

Source: apinrdw/kumora#17
