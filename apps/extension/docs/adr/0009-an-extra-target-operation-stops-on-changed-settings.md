# An extra-target operation stops on changed settings

The owner can change or clear the extra target on the options page while the worker is mid-operation. So an operation on the extra target (a catch-up walk, a post, a status read, a checkpoint load or save) captures the held settings as it starts and asks `haltOf` before each step, each retry included. On other settings, or on a refusal, it stops and its result is dropped.

Sites:

- `apps/extension/src/worker/broker-codes/target-hold.ts`

Source: apinrdw/kumora#255
