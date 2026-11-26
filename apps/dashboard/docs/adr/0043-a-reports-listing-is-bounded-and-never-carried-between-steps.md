# A reports listing is bounded and never carried between steps

The spec has `plan` alone list reports/ and pass the listing on, but carried between workflow steps it would outgrow a step result. So `plan`, `head` and `summary` each list reports/ with custom metadata themselves, and a listing is capped at 10,000 keys, about sixteen years of reports/ at ~50 a month (~150 on 2026-11-14). A listing is held whole in a Worker's 128 MB, a few MB at the cap, only for the step that lists it; failing at the cap says the layout needs rethinking before memory gives out.

A per-URL lookup was the alternative; it costs a request per listed report.

Sites:

- `apps/dashboard/src/server/archive/bucket.ts`
- `apps/dashboard/src/server/archive/held.ts`

Source: apinrdw/kumora#303, apinrdw/kumora#305
