# Google sign-in is bound by stage

Google sign-in is bound by stage, from Infisical `/dashboard`, on Production and Staging only, never by whether its secret is present. Previews and Dev read `staging`, which holds the client too, but their URLs are not OAuth redirect URIs. On Production or Staging a missing secret fails the deploy rather than hiding Google sign-in.

Sites:

- `apps/dashboard/alchemy.run.ts`

Source: apinrdw/kumora#89
