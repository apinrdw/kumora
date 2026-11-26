# A stored disclosure is never fetched again

The shareholding and KSEI archives check each held file for a change and keep every version they find. A disclosure is published once, and a correction is a disclosure of its own, so the disclosure archive does the opposite: a disclosure version or attachment, once stored, is never fetched again and never versioned. A disclosure run decides what to store from ArchiveDb's disclosure index alone: a version listed under a key and language the index holds is passed over however IDX lists it now, and an attachment whose row is stored is never downloaded. Every write to the bucket first checks that its object is absent, so a retried step never overwrites what its first attempt wrote. Where the bucket holds an object the index lacks, as when a step wrote it and failed to index it, the object is the source of truth: a version is indexed with the attachments its stored reply lists, and an attachment is indexed stored with the object's size, without asking IDX again. Over ~600k files this keeps a run's requests to what the archive lacks. A disclosure version IDX edits after it was stored keeps the reply first stored, and the attachments that reply lists.

Sites:
- `apps/dashboard/src/server/disclosures/archive-run.ts`

Source: apinrdw/kumora#715, apinrdw/kumora#716
