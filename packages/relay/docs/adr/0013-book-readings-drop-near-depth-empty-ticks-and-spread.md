# Book readings drop near depth, empty ticks and spread

Book readings no longer carry near depth, empty ticks or the spread. Lots stay, because `limitOf` reads an empty side from them.

Sites:

- `packages/relay/src/book-readings.ts`

Source: apinrdw/kumora#601
