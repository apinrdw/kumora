# An attachment failing for 7 days is unavailable

A disclosure day becomes complete only when none of its attachments waits (ADR 0138), so one file IDX lists but never serves would hold its day back, and every run would take that day up first and try the file again, for good. A disclosure run therefore gives up on an attachment once its failures span 7 days: the index records the instant of its first failed download (`disclosure_attachment.first_failed_at`), and a failed download at least 7 × 24 hours after that instant records the attachment unavailable (`unavailable_at`, `archive-migrations/0007_disclosure_attachment_unavailable.sql`). The span runs from the first failure to the latest, by the run's clock, however many runs fell between them; it doesn't count runs or days with a failure, and a run that never reached the file (its budget spent) adds nothing. A download that succeeds first stores the file and clears its failures, so a later outage starts a new span. An unavailable attachment no longer waits: no run tries it again, it doesn't keep a run partial, and its day may become complete. The run that records it still ends partial, since its download failed. The admin page lists unavailable attachments, newest first.

Counting failed runs was the alternative: at one run every 15 minutes a count says little about how long IDX has been without the file, and it would be wrong for a stage where runs only start with Run now. Retrying an unavailable attachment now and then was another; the spec says it is no longer retried, and a complete day is never listed again (ADR 0138), so nothing would take it up.

Sites:
- `apps/dashboard/src/server/disclosures/disclosure-index.ts`

Source: apinrdw/kumora#715, apinrdw/kumora#719
