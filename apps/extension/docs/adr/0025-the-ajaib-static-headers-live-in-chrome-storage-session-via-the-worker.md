# The Ajaib static headers live in chrome.storage.session, by way of the worker

Ajaib answers 403 to a REST call without the page's static headers (`X-Ht-Ver-Id`, `X-Product`, `X-Platform`, `X-Device-Name`, `x-web-version`, `x-app-mode`, `Accept`), and after the close a reloaded Ajaib page drives its data over sockets and may make no REST call of its own, so a walk call had none to send. The content script now drops the headers that sign one call (`Authorization`, `X-Device-Signature`) from each page call's headers and reports the rest, with the API base, to the worker. The worker keeps the latest in `chrome.storage.session` until Chrome closes and sends them to each Ajaib tab as it connects, which signs its walk calls with them until its page makes a call. The worker holds them, not the content script, because session storage is out of content scripts' reach (ADR 0016); local storage would outlive the browser session for no gain. Nothing that signs a call is ever stored.

Sites:

- `apps/extension/src/content/broker.ts`
- `apps/extension/src/worker/settings.ts`
- `apps/extension/src/worker/tab.ts`

Source: apinrdw/kumora#710
