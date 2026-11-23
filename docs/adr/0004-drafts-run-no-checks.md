# Drafts run no checks

A draft PR runs no CI and gets no `e2e-evidence` status; marking it ready for review runs both on the head it has when it leaves draft. A job skipped by its `if` reports skipped, which a required check accepts, and a draft can't merge anyway, so skipping drafts costs no safety.

Sites:
- `.github/workflows/ci.yml`
- `.github/workflows/e2e-evidence.yml`

Source: none
