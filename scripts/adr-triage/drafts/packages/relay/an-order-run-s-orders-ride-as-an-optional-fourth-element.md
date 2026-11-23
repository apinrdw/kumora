# An order run's orders ride as an optional fourth element

In a sweep brokers entry, an order run's orders ride as an optional fourth element after the sides, and a per-broker piece has none. A row stored before them decodes as it is, so `SWEEP_BROKERS_SHAPE` stays and no old day rebuilds.

Sites:
- `packages/relay/src/recorded-day.ts`

Source: apinrdw/kumora#627
