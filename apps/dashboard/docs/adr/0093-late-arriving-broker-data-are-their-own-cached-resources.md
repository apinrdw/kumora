# Late-arriving broker data are their own cached resources

A recorded day's tape and sweeps answers are sealed and cached for a year, but broker codes and the brokers behind each sweep arrive after the seal, and a later batch may still change them. So the codes answer and the sweep brokers answer are their own resources, cached as the codes answer is and never immutable. The tape's answer stays byte-identical, and the codes answer covers the trades the tape answer at the same cursor (`at`, and `before` when given) holds, picked the same way, so the page sends no trade numbers.

Sites:

- `apps/dashboard/src/server/market-live/recorded-answers.ts`

Source: apinrdw/kumora#343
