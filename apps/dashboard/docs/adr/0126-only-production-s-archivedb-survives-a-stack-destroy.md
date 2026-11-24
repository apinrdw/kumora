# Only Production's ArchiveDb survives a stack destroy

ArchiveDb holds what the archive admin pages read. The report index rebuilds from R2, but the runs that move into it later do not. Production's ArchiveDb is therefore retained (`RemovalPolicy.retain`) across a stack destroy, as Production's buckets survive one (ADR 0006). Any other stage's ArchiveDb is destroyed with its stack. Where ArchiveDb lives, and how a move keeps its rows, is ADR 0124.

Sites:
- `apps/dashboard/alchemy.run.ts`

Source: apinrdw/kumora#659
