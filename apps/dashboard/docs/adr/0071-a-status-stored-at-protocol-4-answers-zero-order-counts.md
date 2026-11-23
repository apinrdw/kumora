# A status stored at protocol 4 answers zero order counts

A day moved cold before broker codes protocol 5 stored its status at protocol 4, without order numbers. Such a day holds no order numbers, so its status answers the current protocol with zero order number counts rather than failing the GET.

Sites:
- `apps/dashboard/src/server/market-live/cold-days.ts`

Source: apinrdw/kumora#627
