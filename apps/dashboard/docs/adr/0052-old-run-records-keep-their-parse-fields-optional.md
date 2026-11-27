# Old run records keep their parse fields optional

The archive run used to parse classification reports too, and the run records written then hold those parse fields. A run no longer parses, so no new record has them and the admin page doesn't show them, but the fields stay optional in the schema so the old records still decode.

Sites:

- `apps/dashboard/src/server/shareholding/run-result.ts`

Source: apinrdw/kumora#402
