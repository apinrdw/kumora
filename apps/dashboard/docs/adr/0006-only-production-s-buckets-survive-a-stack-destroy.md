# Only Production's buckets survive a stack destroy

Each stage gets its own buckets, beside the stage's other objects: the cold days bucket, the shareholding archive's and the KSEI archive's. Production's buckets survive a stack destroy; any other stage's is emptied and destroyed with it. A Preview teardown therefore takes its days and never stops on a bucket that a Run now filled.

Sites:

- `apps/dashboard/alchemy.run.ts`

Source: apinrdw/kumora#305, apinrdw/kumora#556
