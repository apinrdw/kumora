# Walk order: Ajaib tape, Done Details, then Stockbit

After the close the run queue walks a day in a fixed order: Ajaib's tape walk, then its Done Details walk of the trades the tape walk kept, then Stockbit's walk, which fills the order numbers Ajaib's left. A day this browser didn't tape-walk from Ajaib keeps no trades, so its order numbers come from Stockbit alone.

Sites:

- `apps/extension/src/worker/service-worker.ts`

Source: apinrdw/kumora#627
