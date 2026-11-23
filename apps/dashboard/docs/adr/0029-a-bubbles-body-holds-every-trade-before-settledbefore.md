# A bubbles body holds every trade before settledBefore

A Market Bubbles body holds every trade that reached the Worker before its `settledBefore`, on the same clock as the messages' `at`. Only a body settled past this socket's snapshot takes back an earlier socket's minutes, and only one settled past a recount's trigger recounts; one settled short, however early it was asked for, leaves both waiting.

Sites:
- `apps/dashboard/src/lib/bubbles.ts`

Source: apinrdw/kumora#436
