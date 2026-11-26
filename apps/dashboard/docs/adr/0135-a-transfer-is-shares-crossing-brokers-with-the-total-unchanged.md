# A Transfer is shares crossing brokers with the total unchanged

IDX's daily above-5% report lists each holder's securities accounts, and a holder can move shares between them without buying or selling: on 24 Nov 2026 Mohammad Jusuf Hamka moved 290,000,000 CMNP shares from HSBC (a custodian) to Profindo (RG), his 9.22% unchanged. Holder moves read only a holder's total, so that day showed nothing. A Daily holder move is now a Transfer when the holder's total is unchanged against the day before and, netting each broker's accounts (a bank's by its custodian name), shares left some brokers for others. Netting by broker means a renamed or split account, or one broker spelled two ways, is no Transfer. A holder whose total changed stays Up or Down, whatever crossed between its accounts: one line carries one move. Holder moves stores a Transfer's sides as custodians, the brokers it left and reached, and the shares that moved, in `above_5_move.transfer` (`holdings-migrations/0013_holder_move_transfer.sql`, which widens the `move` CHECK); their broker codes are looked up on read (ADR 0132). Monthly never has one: the above-1% report has no accounts, and `above_1_move.transfer` stays NULL so both kinds keep one set of columns. Undoing this means a migration that narrows the CHECK again and a bump of the Daily derivation's version.

Sites:

- `apps/dashboard/src/lib/daily-holders.ts`
- `apps/dashboard/src/lib/holder-identity.ts`
- `apps/dashboard/src/server/holdings/above-5-moves.ts`
- `apps/dashboard/src/server/holdings/holder-moves.ts`

Source: apinrdw/kumora#700
