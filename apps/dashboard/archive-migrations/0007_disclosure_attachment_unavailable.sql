-- When an attachment became unavailable (spec apinrdw/kumora#715, ticket
-- #719): every run's download of it failed for 7 days from the first
-- failure. No run tries it again, and its day may become complete without
-- it (apps/dashboard/docs/adr/0139).
-- An ISO instant; null while it is stored or still tried.
ALTER TABLE disclosure_attachment ADD COLUMN unavailable_at TEXT;

-- The attachments that wait: neither stored nor unavailable. Replaces the
-- index of those not stored, which would cover unavailable rows too.
DROP INDEX disclosure_attachment_waiting;

CREATE INDEX disclosure_attachment_waiting ON disclosure_attachment (day)
WHERE stored_at IS NULL AND unavailable_at IS NULL;

-- The unavailable attachments, newest first, for the admin page's list.
CREATE INDEX disclosure_attachment_unavailable
ON disclosure_attachment (unavailable_at)
WHERE unavailable_at IS NOT NULL;
