# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Active retail traders on the Indonesian stock exchange (IDX): day traders and swing traders who watch the session live (pre-opening 08:45 WIB through the close) and want to see who is buying and selling, not only the price. They read the tape, broker flow and the order book while the market is open, and review recorded days after the close.

Secondary, inside the dashboard: admins who manage accounts (ban and unban, change role, end sessions, impersonate members) and run the shareholding and KSEI archive pages. The owner also runs the relay extension in their own browser to feed the terminal; the extension has no end users beyond the owner.

## Product Purpose

KUMORA is a market terminal for IDX ("follow the smart money"). It shows each trade with the brokers and investor types behind it, live and for recorded days, plus order-flow charts, live alerts and holdings data, so a trader can follow accumulation and distribution by the money that moves price.

Success: a trader keeps it open through the session and acts on what it shows: a sweep, a broker accumulating, a wall eaten, a holder changing position.

## Positioning

The broker apps IDX traders already use (Stockbit, Ajaib) show prices, a tape and broker summaries. KUMORA layers four things they do not combine:

- **Broker codes on every trade.** Every running trade carries its buyer and seller broker codes and investor types (domestic or foreign), live and for recorded days, so flow is traceable trade by trade.
- **Order-flow visuals.** Footprint charts with delta, sweeps drawn as bubbles over a book heatmap, the order book radar, Market Bubbles: order-flow tooling that retail IDX apps lack.
- **Live alerts on flow events.** Sweep alerts with sound, book events (absorbed, eaten, reloaded, walls) and order-flow events (exhaustion, delta divergence, failed break), told while the page is open.
- **Holdings data.** IDX shareholding reports and KSEI investor-type holdings history beside the tape: who holds a stock, and how that changed.

## Operating Context

- Used during IDX trading days, mostly on a desktop browser that stays open all session, often beside a broker app where the trader places orders. KUMORA does not place orders.
- Market phases matter: pre-opening auction, the continuous session, pre-closing auction, after the close. Live pages run while the market streams; after the close, users read recorded days.
- Times are WIB. Values are rupiah, volumes are lots; a big trade is at least Rp1 B.
- Pages today: Market Live (footprint chart over a candle chart with sweeps and book heatmap, the tape), order book radar, Market Bubbles, stock search and the stock page (shareholders composition, major holders), /account, and the admin pages (users, shareholding, KSEI).
- Each browser keeps its own settings and watchlist in localStorage. Alerts come from one tab per browser: a toast on the visible page, a browser notification from a background tab.

## Capabilities and Constraints

- Monorepo: `apps/dashboard` (the terminal), `apps/web` (public site), `apps/extension` (the owner's relay, an unpacked Chrome MV3 extension), `packages/ui` (shared shadcn/ui components and Tailwind styles). TanStack Start on Cloudflare Workers, deployed by Alchemy.
- Access is by waitlist. Visitors take a queue number on the public site (`apps/web`) and are let in by email in queue order. Once invited, they sign up in the dashboard (email or Google).
- Every dashboard page passes the sign-in gate: a session of a verified, unsuspended account. Only verified accounts see market data. Roles: member (every page but admin) and admin.
- Market data comes from the owner's signed-in broker tabs through the relay; a feed is unavailable when its broker tab is closed. Freshness, feed lag and relay gaps are real states the UI must show honestly.
- Terminology is owned by `apps/dashboard/GLOSSARY.md` (stock code, not ticker; running trade, not tick; broker code; sweep; footprint). UI copy follows it.
- The dashboard renders dark only today (`className="dark"` on the root).
- `apps/web` is the public site: the Market Passbook landing with the waitlist, in English at `/` and Indonesian at `/id`. Its sign-in link is hidden for now.
- Language: the product is meant to speak both Bahasa Indonesia and English, switchable by the user. The web landing ships both (`apps/web/src/lib/copy.ts`); its Indonesian copy is a draft awaiting the owner's review. The dashboard is English only with no i18n layer; how its switch is stored and which language is the default are open.
- Pricing, plans and paid tiers: undecided. Do not show any.

## Brand Commitments

- Name: KUMORA, with the wordmark "KUMORA AI". Tagline: "follow the smart money".
- Logo sources: `assets/brand/kumora-icon.png` (square app icon) and `assets/brand/kumora-wordmark.png` (icon with wordmark, transparent). Every favicon, PWA icon, header logo and the Open Graph image is generated from them by `scripts/brand-assets.py`; never redraw them.
- Keep the IDX market vocabulary traders use, in either language.

## Evidence on Hand

- Real market data: live and recorded trading days of the IDX tape with broker codes, order books, IDX shareholding reports and KSEI holdings, all in the deployed stages.
- Brand assets above, and `apps/web/public/og-image.jpg`.
- No testimonials, user counts, press, performance claims or case studies exist. Do not invent them, and do not claim trading returns.

## Product Principles

1. **Truth before polish.** Show where data comes from and how fresh it is; a gap, lag or closed feed is shown, never hidden behind a smooth chart.
2. **The session is the scene.** Design for a trader watching a moving market for hours: fast scanning, stable layouts, alerts that cut through only when they matter.
3. **Flow over price.** Who traded, which side was aggressive, and what the book did come first; price is the context.
4. **Use the market's own words.** Glossary terms and the vocabulary IDX traders already use, consistently, in both languages.
5. **Inform, never advise.** KUMORA shows what happened; it does not tell anyone to buy or sell.
