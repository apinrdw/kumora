# Each test names its results folder in an annotation

The Playwright JSON report lists only the built-in context's videos, not a hand-built context's `page@<hex>.webm`, and gives no folder for a test with none. So each test names its results folder in a `results-folder` annotation, and `scripts/e2e-evidence-plan.mts` reads it and attaches every `.webm` in that folder as e2e evidence.

Sites:
- `apps/e2e/support/test.ts`

Source: apinrdw/kumora#211
