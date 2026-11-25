# Broker codes are looked up on read

IDX's daily above-5% report names each account's custodian, never its broker code, and spells the custodian as KSEI records it (`PANIN SEKURITAS Tbk, PT`). IDX's exchange-member list (`GetBrokerSearch`) gives each member firm's code and name. `pnpm idx:exchange-members` fetches that list once and writes it into the checked-in `src/lib/exchange-members.ts`; the dashboard never calls IDX for it. A custodian takes the code of the member whose name equals its own once both are uppercased and stripped of punctuation and `PT`, `TBK` and `PERSERO`, or, when it is KSEI's holding account for a closed member (`CLOSED MEMBER-SM001`, `TAMP QA001`, `TAMPUNGAN MK001`), the code its name carries. Any other custodian (a bank, KSEI's lending account, a broker IDX no longer lists) has none and shows as Custodian. On 25 Nov 2026 the 88 members cover 82 of the report's 123 custodians and 76% of account-days, and the name carries the code of 11 more. The code is looked up when Daily holders and Holder moves read a day, never stored with the parsed accounts, so rerunning the script reaches every past day without a re-parse; the cost is that a past day shows a broker's code as IDX lists it now. Undoing this means storing codes at parse time, which needs a parser version bump to reach old days and freezes a renamed or closed broker's code.

Sites:
- `apps/dashboard/src/lib/broker-code.ts`

Source: apinrdw/kumora#673
