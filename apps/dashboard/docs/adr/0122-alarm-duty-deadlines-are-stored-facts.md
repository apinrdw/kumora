# Alarm duty deadlines are stored facts

A trading-day object has one alarm but several duties. Each duty's deadline is a fact in the day's store, written whenever it is set, so a start restores it and never moves it. The alarm is armed for the earliest; it runs only the due duties, and each checks its own precondition before it acts.

Sites:

- `apps/dashboard/src/server/market-live/wakes.ts`

Source: apinrdw/kumora#437
