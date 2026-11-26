# A stored disclosure is never fetched again

The shareholding and KSEI archives check each held file for a change and keep every version they find. A disclosure is published once, and a correction is a disclosure of its own, so the disclosure archive does the opposite: a disclosure version or attachment, once stored, is never fetched again and never versioned. A disclosure run decides what to store from ArchiveDb's disclosure index alone: a version listed under a key and language the index holds is passed over however IDX lists it now, and an attachment whose row is stored is never downloaded. Every write to the bucket first checks that its object is absent, so a retried step never overwrites what its first attempt wrote. Over ~600k files this keeps a run's requests to what the archive lacks. A version IDX edits after it was stored keeps its first listing.

Sites:
- `apps/dashboard/src/server/disclosures/archive-run.ts`

Source: apinrdw/kumora#715, apinrdw/kumora#716
