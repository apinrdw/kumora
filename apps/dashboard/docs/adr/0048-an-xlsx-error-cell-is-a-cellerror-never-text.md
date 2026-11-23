# An xlsx error cell is a CellError, never text

Read as text, an xlsx error cell such as `#N/A` was stored as a stock. An error cell is now a `CellError`, never text, and each parser decides what it means: the classification and investor-type parses read through `forEachRowWithoutErrors`, so any error fails them; the above-1% parse skips Apr 2026's `#DIV/0!`-only rows and fails on an error in a cell it reads.

Sites:
- `apps/dashboard/src/server/holdings/xlsx.ts`

Source: apinrdw/kumora#473
