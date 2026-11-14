# Dashboard

The market terminal for the Indonesian stock exchange. Today it has the shell, sign-in and accounts, `/account` and the admin pages; Market Live is still to come.

## Language

### Prices and flow

**Candle**:
The open, high, low, close, and volume of one period.
_Avoid_: Bar

**Stock code**:
The IDX ticker that names one listed instrument, such as `BBCA`.
_Avoid_: Symbol, ticker

**Watchlist**:
The stock codes and indices a user chooses to keep an eye on, each with its day state. Each browser keeps its own.
_Avoid_: Favourites, portfolio

**Big trade**:
A running trade worth at least Rp1 B (one billion rupiah).
_Avoid_: Whale trade

**Frequency**:
A count: of the running trades a stock code has had in the day so far, or of the resting orders at one order book price level.
_Avoid_: Trade count, ticks

**Running trade**:
One executed trade on the exchange's tape: its time, stock code, price and lots, and the buyer and seller brokers when the feed carries them. The running trades of every stock code together make the tape.
_Avoid_: Done trade, tick

**Broker code**:
The exchange's code for the member firm on one side of a running trade, such as `YP`. Each running trade has a buyer broker code and a seller broker code.
_Avoid_: Broker ID, broker name

**Investor type**:
Whether the investor behind one side of a running trade is domestic or foreign. Each running trade has a buyer investor type and a seller investor type. It describes the investor, not the broker: a foreign broker can trade for a domestic investor.
_Avoid_: Foreign flag, broker type

**Cross-check**:
A second broker site's copy of a trading day's broker codes and investor types, compared trade by trade with the copy the terminal keeps. It reports where the two differ and never changes the kept copy.
_Avoid_: Verification, reconciliation

**History walk**:
Fetching the broker codes of trading days from before the terminal started keeping them, newest day first, until the broker site stops serving older days.
_Avoid_: Backfill (that is filling gaps in the live tape)

**Trade number**:
The exchange's number for a running trade: one sequence across the whole market, restarting each trading day. Every feed that reports the same trade gives it the same trade number.
_Avoid_: Trade ID, sequence

**Board**:
The exchange market a running trade happens on: regular, cash, or negotiated. Candles count only regular-board trades.
_Avoid_: Market type

**Indicative price**:
The price, and the volume with it, that an auction would match at if it closed now. Published only during pre-opening and pre-closing, and shown only while the auction of its time runs: pre-closing shows nothing until its own first frame, never the morning's price.
_Avoid_: IEP, projected price

**Auction match**:
The running trades a pre-opening or pre-closing auction produces when it closes: every stock code at its one matched price, all stamped with the same second. They carry no buy or sell side.
_Avoid_: Crossing, uncross, opening print

**Day state**:
A stock code's or index's figures for the trading day so far: last price, previous close, change, open, high, low, volume, value and frequency. The previous close and the change are absent until a frame of the code carries a previous close, which an index's never do; a price seen today never stands in for it.
_Avoid_: Quote, summary

**Order book**:
The resting buy orders (bid) and sell orders (offer) for one stock code, as price levels with their lots and number of orders.
_Avoid_: Depth, market depth

**Net flow**:
Net broker buying minus selling for an instrument over a period, in rupiah, from end-of-day data. Absent when the feed has no coverage.
_Avoid_: Broker flow (for the figure), flow

### Freshness

**Feed**:
A source the terminal draws figures from, such as a price feed or a broker end-of-day feed.

**Relay**:
The browser extension's path that captures a broker site's live data from the owner's signed-in session and forwards it to the terminal, which keeps each trading day and serves it to viewers. Each broker site it relays from is its own feed.

**Provenance**:
Which feed a figure came from and its as-of.

**As-of**:
The instant a figure was last true at its source.

**Freshness**:
How current a figure is relative to its feed: live, delayed, end-of-day, stale, unavailable, or demo. Live means arriving now; it does not mean the feed is licensed. Delayed means arriving, but with a feed lag far behind the exchange.

**Feed lag**:
How long after the exchange's trade time a relayed running trade first reached the terminal. A quiet feed has no feed lag, only an old as-of.
_Avoid_: Tape lag, delay, latency

**Market phase**:
The part of the trading day the exchange is in: pre-opening, session 1, break, session 2, pre-closing, post-trading, closed, or holiday. A quiet feed in a phase where no trades are expected is still live.
_Avoid_: Market status, session (for the whole day)

**Recorded day**:
A past trading day the terminal kept, fixed after the day closes, that a viewer can replay.
_Avoid_: History, archive day

**Relay gap**:
A stretch of a market phase that expects trades during which no feed was arriving, so the terminal holds no trades for it. Shown as not recorded, both live and on a recorded day. One feed dropping while the other still arrives is not a relay gap, and neither is a delayed feed.
_Avoid_: Outage, missing data

**Market conditions**:
What a trading day tells every viewer besides the figures: the market phase, each feed's freshness and the relay gaps so far. Sent in every snapshot, and in a delta whenever any of it changed; the chart header shows them.
_Avoid_: Market status, status bar

**Replay cursor**:
The moment of a recorded day the page shows: the chart, watchlist, order book and tape all read as of it.
_Avoid_: Playhead, timestamp

### Shareholding

**Shareholding report**:
One file IDX publishes on its Data Kepemilikan Saham page, as of one date. It is kept exactly as published.
_Avoid_: Ownership filing, kepemilikan file

**Report kind**:
Which of IDX's four shareholding reports a file is: holders above 5% (daily), holders above 1%, holdings by investor type, or holdings by investor classification (each month-end).
_Avoid_: Report type, category

**Shareholding archive**:
Every shareholding report the dashboard has kept, each version of it included. Nothing in it is ever overwritten or removed.
_Avoid_: Ownership archive, IDX archive

**Archive run**:
One pass that compares IDX's list of shareholding reports with the shareholding archive and stores any report, or new version of one, that the archive lacks. The schedule starts one twice a day, and an admin can start one when none is in progress. It ends **complete**, **partial** (some reports could not be stored and wait for the next run) or **failed**.
_Avoid_: Sync, scrape, job

### Access

**Account**:
A person's identity on one stage of the dashboard: an email, a name, a role and its sign-in methods. Accounts don't carry from one stage to another.
_Avoid_: Profile, login

**Sign-in method**:
A way an account proves who it is: a password, or Google. One account can have both.
_Avoid_: Provider, linked account

**Verified account**:
An account whose email has been proven, by a link sent to it or by Google. Only a verified account sees market data.
_Avoid_: Confirmed account, activated account

**Session**:
One signed-in browser of an account, from sign-in until sign-out, expiry, revoke or ban.
_Avoid_: Login, token

**Sign-in gate**:
The check every page, the Market Live socket and every recorded day load must pass: a session of a verified account that isn't suspended.
_Avoid_: Auth wall, login wall

**Feature**:
A part of the dashboard that access is decided for as a whole, such as Market Live or the admin pages.
_Avoid_: Module, permission

**Access policy**:
The one set of rules that decides whether an account may take an action on a feature or on another account. Every check of access asks it.
_Avoid_: Permissions, ACL

**Member**:
The role every account starts with. A member sees every page except the admin pages.
_Avoid_: User (for the role), viewer (for the role)

**Admin**:
The role that manages other accounts: ban and unban, change role, end sessions, and impersonate members.
_Avoid_: Moderator, owner

**Config admin**:
A verified account whose email is on the configured admin list. It is an admin from the moment its email is on the list, even before its next sign-in stores the role. It can't be banned or demoted, have its sessions ended by another admin, change its email, or delete itself.
_Avoid_: Super admin, root

**Suspended account**:
An account an admin has banned. It can't sign in until an admin unbans it.
_Avoid_: Blocked account, disabled account

**Impersonation**:
An admin viewing the dashboard as one member, for a limited time, without being able to change that member's account.
_Avoid_: Act as, sudo

### Shell

**Shell**:
The frame around every page: sidebar, header, and mobile bottom bar. It reads no market data.
