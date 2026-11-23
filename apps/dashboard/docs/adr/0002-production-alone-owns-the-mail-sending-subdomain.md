# Production alone owns the mail sending subdomain

Production alone owns the `mailer.pusat.ai` sending subdomain. Every other stage only binds EMAIL with that sender, so destroying a Preview never removes the subdomain, and their mail fails until Production has deployed it. Message previews are off on the subdomain, because Alchemy's SendEmail binding has no `previewEnabled`.

Sites:
- `apps/dashboard/alchemy.run.ts`

Source: apinrdw/kumora#82
