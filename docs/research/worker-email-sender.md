# Which email sender delivers verification and reset mail from a Cloudflare Worker

Research for [#67](https://github.com/apinrdw/kumora/issues/67), child of the map [#63](https://github.com/apinrdw/kumora/issues/63). Researched 2026-11-07.

Sources:

- Vendored Alchemy in `repos/alchemy`, `@alchemy.run/cloudflare` `2.0.0-beta.85`. Paths below are relative to `repos/alchemy`.
- developers.cloudflare.com, resend.com, postmarkapp.com, aws.amazon.com and better-auth.com, fetched 2026-11-07.
- Better Auth source on `main` (`packages/better-auth/src/api/routes/`), fetched 2026-11-07.
- In this repo: `apps/dashboard/alchemy.run.ts`, `packages/deploy/src/{stack,target}.ts`, and the earlier research on `origin/research/infisical-alchemy-secrets` (`docs/research/infisical-alchemy-secrets.md`).

## Answer

1. **Use Cloudflare Email Sending through the Workers `send_email` binding.** Alchemy manages both halves: `Cloudflare.Email.SendingSubdomain` onboards the sending domain and writes its DNS records, and `Cloudflare.Email.SendEmail` declares the binding. The binding needs no API key, so no stage needs an email secret. Under `alchemy dev`, Alchemy writes each message to a `.eml` file under `.alchemy/local/email` instead of sending it. Local dev and e2e get this behaviour with no extra code.
2. **It needs two things kumora does not have today:** the Workers Paid plan ($5/month; 3,000 emails/month included, then $0.35 per 1,000), and a domain added to the Cloudflare account. `workers.dev` is not a domain you can onboard. The dashboard can stay on `workers.dev`. Only the `from:` address needs the owned domain.
3. **Resend is the fallback.** Choose it if the owner won't move to Workers Paid, or if a beta product is not acceptable for auth mail. It is free for up to 3,000 emails/month and 100/day, with up to 3 domains. Alchemy has no Resend resource, so you would add the DNS records by hand or with Resend's Cloudflare Domain Connect button. Each deployed stage would need `RESEND_API_KEY` from Infisical, and local dev would need a code path that logs the link.
4. **Better Auth fits either sender.** Its `sendVerificationEmail` and `sendResetPassword` callbacks receive `{ user, url, token }`. The docs say not to await the send: call it inside `waitUntil` (importable from `cloudflare:workers`) so the response returns at once.

## Comparison

| | Cloudflare Email Sending | Resend | Postmark | Amazon SES |
| --- | --- | --- | --- | --- |
| Free tier | Only on Workers Paid ($5/mo): 3,000/mo included | 3,000/mo, 100/day, 3 domains | 100/mo | Only AWS sign-up credits |
| Low-volume price | $0.35 per 1,000 over 3,000 | Pro $20/mo for 50,000, then $0.90 per 1,000 | Basic $15/mo for 10,000, then $1.80 per 1,000 | $0.10 per 1,000 |
| Domain | A domain in the Cloudflare account. Records go on `cf-bounce.<domain>` plus `_dmarc` | Any DNS host. MX and SPF on `send.<sub>`, DKIM at `resend._domainkey` | Any DNS host | Any DNS host |
| Alchemy manages it | Yes: `Email.SendingSubdomain` and `Email.SendEmail` | No | No | Yes in `@alchemy.run/aws` (`SES.EmailIdentity`), but that needs a second cloud provider |
| Per-stage secret | None, it is a binding | `RESEND_API_KEY` | Server token | AWS access key, plus SigV4 signing in the Worker |
| Local dev | `.eml` files under `.alchemy/local/email`, built in | Needs our own logging path, or a real send to a `@resend.dev` test address | Needs our own logging path | Needs our own logging path |
| Status | Beta | GA | GA | GA |

Postmark and SES were ruled out early. Postmark's free tier is 100 emails/month, and SES brings AWS credentials, SigV4 signing and sandbox exit into a Cloudflare-only stack. Neither has an advantage over the two leaders that this project needs.

## 1. Cloudflare Email Sending

### What it is and what it costs

- Cloudflare Email Service has two parts. **Email Sending** is in beta, needs Workers Paid, and sends transactional mail. **Email Routing** handles inbound mail on Free and Paid ([overview](https://developers.cloudflare.com/email-service/)).
- Pricing: "3,000 included per month" on Workers Paid, then "$0.35 per 1,000 emails". "Sending to arbitrary recipients requires the Workers Paid plan." Sends to *verified destination addresses* are free and don't count toward the quota ([pricing](https://developers.cloudflare.com/email-service/platform/pricing/)).
- Limits: "New accounts start with a conservative daily quota and scale up over time". No number is published, and a form requests increases. A message may have at most 50 recipients and be at most 25 MiB. "Before you onboard a sending domain, you can only send to verified destination addresses" ([limits](https://developers.cloudflare.com/email-service/platform/limits/)).
- You can send through the Workers binding, the REST API, or SMTP. `env.EMAIL.send({ from, to, subject, html, text, ... })` resolves to `{ messageId }`. A failure throws an `Error` with a `code` property. The codes include `E_SENDER_DOMAIN_NOT_AVAILABLE`, `E_RECIPIENT_NOT_ALLOWED`, `E_RECIPIENT_SUPPRESSED`, `E_RATE_LIMIT_EXCEEDED` and `E_DAILY_LIMIT_EXCEEDED` ([Workers API](https://developers.cloudflare.com/email-service/api/send-emails/workers-api/)).

### Sending domain and DNS

- You pick the domain "from your Cloudflare account" under Compute > Email Service > Email Sending > Onboard Domain. Cloudflare can write every record ([domains](https://developers.cloudflare.com/email-service/configuration/domains/)):
  - `MX cf-bounce.<domain>` → `route{1,2,3}.mx.cloudflare.net` (bounces)
  - `TXT cf-bounce.<domain>` → `v=spf1 include:_spf.mx.cloudflare.net ~all`
  - `TXT cf-bounce._domainkey.<domain>` → DKIM key
  - `TXT _dmarc.<domain>`. Cloudflare recommends `p=none` to start.
- Records usually take 5–15 minutes on Cloudflare DNS. The page does not say what happens when the zone's DNS is hosted elsewhere. Alchemy's `SendingSubdomain` doc covers "zones not on Cloudflare DNS": you fetch the records with `emailSending.getSubdomainDns` and create them at your DNS host. Either way, the domain must be a zone in the Cloudflare account.
- **`workers.dev` cannot be a sender.** It is Cloudflare's domain, not a zone in our account. Kumora needs to register or move a domain into the account. The dashboard Worker can keep serving from `*.kumora.workers.dev`, because the sender domain and the site's host are independent. A sending subdomain such as `mail.<domain>` keeps the apex free for a future custom domain for the site.
- One zone can hold 30 sending and routing domains in total. Production, staging and previews can share one sending subdomain, or production can use its own (`mail.` against `mail-staging.`) to keep sender reputations apart.

### What Alchemy manages (`repos/alchemy`)

- `packages/cloudflare/src/Email/SendingSubdomain.ts` defines `Cloudflare.Email.SendingSubdomain({ zoneId, name, previewEnabled? })`. It registers the subdomain, and on a Cloudflare DNS zone the DKIM, SPF and return-path records are created automatically. The `enabled` attribute flips to `true` once they validate. Changing `name` or `zoneId` replaces the subdomain. An existing subdomain is reported `Unowned` and needs `--adopt`. With `previewEnabled` on, Cloudflare keeps a copy of each sent message in the activity log for about seven days. For mail that carries verification and reset links, consider `previewEnabled: false`.
- `packages/cloudflare/src/Email/SendEmail.ts` defines `Cloudflare.Email.SendEmail(id, { allowedSenderAddresses?, destinationAddress? | allowedDestinationAddresses? })`. It is a binding descriptor only and creates no cloud resource. An Effect Worker binds it with `Cloudflare.Email.Send(...)` plus the `Email.SendBinding` layer, and gets `send`, `sendRaw` and `raw` with a typed `SendEmailError` (`Email/Send.ts`, `Email/SendBinding.ts`).
- An async Worker such as the dashboard's TanStack Start entry puts the descriptor on its `env` prop. `Workers/WorkerAsyncBindings.ts` turns `isSendEmail(binding)` into a `send_email` binding. `Cloudflare.InferEnv<typeof Website>` then types `env.<name>` as the runtime `SendEmail`. The working example is `examples/cloudflare-email/` (`alchemy.run.ts`, `src/Email.ts`, `src/Api.ts`).
- Alchemy's prose docs (`website/src/content/docs/cloudflare/email/index.mdx`) still describe the older routing-era rule that "the `to:` address must be a verified destination". After a domain is onboarded to Email Sending, Cloudflare's current limits page lifts that rule. The binding descriptor is the same either way.
- Where it would go: `apps/dashboard/alchemy.run.ts` today builds `Cloudflare.Website.Vite("Dashboard", ...)` from `websiteProps(...)` (`packages/deploy/src/stack.ts`). The sender would add the `SendingSubdomain` in the stack body, or adopt one created by hand, and add a `SendEmail` descriptor to the Website's `env`. `allowedSenderAddresses: ["noreply@mail.<domain>"]` stops a bug from sending as any other address.

### Local dev, test and preview stages

- `alchemy dev` runs the binding on a local simulator: "a `send_email` binding persists messages as `.eml` files under `.alchemy/local/email`" (`website/src/content/docs/cloudflare/local-development.mdx`; `packages/cloudflare-runtime/src/core/bindings/send-email/SendEmail.ts`). `Alchemy.remote()` on the descriptor opts a dev session into real sends.
- So **Dev stage** and **Test stage** (`pnpm dev`, and e2e on stage `test`) never send mail. The verification link appears in a file on disk, where the developer or Playwright can read it. Alchemy's own integration tests poll that directory (`packages/integration-tests/test/Cloudflare/Email/SendEmail.local.test.ts`).
- Deployed **Preview** and **Staging** stages send real mail and use the shared quota. You can keep a preview from mailing strangers by giving its descriptor `allowedDestinationAddresses` with verified owner addresses. Mail to verified destinations is free and outside the quota. Open sign-up on a preview then works only for those addresses. The grilling ticket on per-stage config owns that trade-off.

### Deliverability

No first-party deliverability figures exist for either product. Cloudflare signs with DKIM on its own `cf-bounce` return path and runs a suppression list, and its new accounts start on a low, unpublished daily quota. Because Email Sending is in beta, a sudden quota cut or behaviour change would block sign-ups. Watch for `E_DAILY_LIMIT_EXCEEDED`. At kumora's volume (one verification per sign-up, occasional resets) the quota is unlikely to bind.

## 2. Resend

- Pricing: the free plan allows "100 emails/day and 3,000 emails/month" and "up to 3 verified domains". Pro costs $20/month for 50,000 emails, then $0.90 per 1,000. Data is retained 30 days ([pricing](https://resend.com/pricing), [quotas](https://resend.com/docs/knowledge-base/account-quotas-and-limits)). The API allows 10 requests/s per team.
- Domain: it must be a domain you own, and a subdomain is recommended ([domains](https://resend.com/docs/dashboard/domains/introduction)). The records on Cloudflare are `MX send` (`feedback-smtp.<region>.amazonses.com`), `TXT send` (`v=spf1 include:amazonses.com ~all`) and `TXT resend._domainkey`, all DNS-only. "Sign in to Cloudflare" (Domain Connect) adds them automatically ([Cloudflare guide](https://resend.com/docs/knowledge-base/cloudflare)). Resend also cannot send from `workers.dev`, so a domain is needed either way. With Resend the domain need not be in the Cloudflare account.
- Workers: use the `resend` SDK with the API key in `RESEND_API_KEY` ([Workers guide](https://resend.com/docs/send-with-cloudflare-workers)). In this repo the key would be a Construction-phase `Config.Redacted` or `env` value, so Infisical supplies it at deploy as `secret_text`. The earlier Infisical research describes that path. Production would read Infisical `prod`; staging and previews would read `staging`.
- Alchemy: no Resend provider exists in `repos/alchemy/packages`. The domain and API keys are created by hand.
- Local dev and e2e: there is no simulator. You can send to Resend's test recipients (`delivered@resend.dev`, `bounced@resend.dev` and others) from `onboarding@resend.dev`, but that is a real API call that needs the key. A local stage would need its own "log the link" sender.

## 3. Better Auth integration

- `emailVerification.sendVerificationEmail({ user, url, token }, request)`, plus `sendOnSignUp`, `sendOnSignIn` and `autoSignInAfterVerification`. `emailAndPassword.requireEmailVerification` blocks sign-in with a 403 until the account is verified. `emailAndPassword.sendResetPassword({ user, url, token }, request)` sends the reset mail ([email concepts](https://better-auth.com/docs/concepts/email)).
- Defaults, from the source: the verification token expires in 3600 s (`email-verification.ts`, `expiresIn: number = 3600`), and the reset token in 1 h (`password.ts`, `defaultExpiresIn = 60 * 60 * 1`, overridden by `resetPasswordTokenExpiresIn`). `revokeSessionsOnPasswordReset` is off by default ([email-password](https://better-auth.com/docs/authentication/email-password)).
- "Avoid awaiting the email sending to prevent timing attacks." On serverless, use `waitUntil` ([email concepts](https://better-auth.com/docs/concepts/email)). Workers exports `waitUntil` from `cloudflare:workers` ([changelog 2025-08-08](https://developers.cloudflare.com/changelog/2025-08-08-add-waituntil-cloudflare-workers)), so the callback needs no `ctx`. With `send_email`, the callback reaches the binding through `env` from `cloudflare:workers` or the request context. The research ticket on running Better Auth on the dashboard Worker owns how that context is wired.

## Open questions

1. **Workers Paid.** Will the owner move the account to Workers Paid ($5/month)? Without it, Cloudflare Email Sending can reach only verified addresses, which rules it out for open sign-up, and Resend becomes the choice.
2. **Which domain.** Is there a domain to add to the Cloudflare account, and which sending subdomain should be used (`mail.<domain>`)? Does production share it with staging and previews, or use a separate one?
3. **Who owns the sending subdomain.** Is it a resource in the dashboard stack, created on production and adopted read-only elsewhere, or created once by hand and only referenced? Destroying a preview must not remove a shared subdomain.
4. **Previews and real mail.** Do deployed previews send to anyone, or only to an `allowedDestinationAddresses` list of verified addresses? This interacts with open sign-up on previews and with e2e against previews.
5. **Message previews.** Should `previewEnabled: false` be set, so Cloudflare does not keep copies of messages that carry reset links?
