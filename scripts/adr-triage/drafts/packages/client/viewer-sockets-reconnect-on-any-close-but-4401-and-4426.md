# Viewer sockets reconnect on any close but 4401 and 4426

A viewer's market-live socket reconnects on any close but 4401 and 4426, with backoff capped at 10 s, and the page resumes from the fresh snapshot the new socket sends. This follows the viewer protocol in spec #138.

Sites:
- `packages/client/src/market-live-socket.ts`

Source: apinrdw/kumora#138
