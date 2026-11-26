# At most 5 auth mails per address per day

Better Auth's per-IP limits slow one client but don't stop one inbox being flooded from many IPs. At most 5 verification and reset mails go to an address per day, counted in D1 beside those limits. The cap protects the inbox and keeps the sender's daily allowance.

Sites:

- `apps/dashboard/src/server/auth/mail-cap.ts`

Source: apinrdw/kumora#71
