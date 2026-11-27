# Done Details rows pair with trades in Ajaib's row order

Ajaib's Done Details rows carry no trade number, so the walk pairs them with the kept tape trades by a key: time, price, lots, buyer code and type, seller code and type, and board, compared exactly. The key has no side: the tape's side and the row's "larger order number is the aggressor" disagree in the 08:58 and 16:00 auctions, which have no aggressor. Ajaib answers a code's rows newest first, so each row, in that order, takes the highest-numbered tape trade left of its key. Rows and trades still unpaired then pair the same way on the key without lots, for NG trades whose fractional lot reads 0 in Done Details and 1 on the tape. Rows alike in every field and both order numbers count once. Pairing is greedy: a key's extra rows (its oldest) or extra trades (its lowest-numbered) stay unpaired for Stockbit's walk, and nothing else is refused, except a code with a row the walk can't read, which could be any key's and would shift every pairing of that key after it.

This replaces ADR 0004's one-run rule, which refused tied trades with other trades of the code between them and sorted a key's rows by order number. A replay of that rule on the owner's console collector's 2026-11-27 file placed 948,541 trades; it refused 149,830 tied trades for the one-run rule, missed 24,901 auction trades on the side in the key, and 3,440 on counts that differed. The collector, pairing by row order, placed 1,126,712 trades that day with 60 differing from Stockbit's. Its PART check on 2026-10-23 got 3,500 of 3,500 trades right, 2,277 of them tied; the reverse row order got 1,913. On HOPE's captured 2026-11-20 rows the rule places 1,311 of 1,312 trades, every one as Stockbit reads it; the one left is a trade Ajaib's route doesn't list.

Sites:

- `apps/extension/src/worker/broker-codes/done-details-walk.ts`

Source: apinrdw/kumora#748
