# A connection's frames go up before its close

A connection's buffered frames go up before its close: the tab drains them from the batcher rather than leaving them to the 250 ms flush. Otherwise a frame could follow its connection's close and revive a connection the dashboard was told is closed. That is the only order the tab fixes: an opened or alive status goes up at once, ahead of frames batched before it.

Sites:

- `apps/extension/src/worker/tab.ts`

Source: apinrdw/kumora#157
