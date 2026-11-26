# Credentials are redacted as text before a cause is stored

The worker stores its Error and Fatal lines and the "Relay stopped" cause where the owner can copy them, so a credential in a cause would leak into a bug report. A cause is redacted as text right before it is stored, rather than carrying credentials as `Redacted`: the text hides a value however it got there, a message built from an unwrapped one included. Redaction hides each credential the worker has read and any JWT, which covers Stockbit's token read from its cookie and never stored. Every credential the worker reads is remembered in memory for this, beside those in storage, because a PIN a failed check or the lock screen wiped, or a token the owner replaced, can still sit in a line logged just before.

Sites:

- `apps/extension/src/worker/error-log.ts`
- `apps/extension/src/worker/settings.ts`

Source: apinrdw/kumora#288
