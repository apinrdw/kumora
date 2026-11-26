---
Sites: none
---

# Broker totals are keyed on code first

BrokerTotalsDb's totals are keyed on stock code first, so one code's range of days is a single key-range read. A separate day index serves the build's delete of a day.

Sites:

- `apps/dashboard/broker-totals-migrations/0001_broker_totals.sql`

Source: apinrdw/kumora#419
