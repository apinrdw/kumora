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
Fetching the running trades and broker codes of trading days from before the terminal started keeping them, newest day first, until the broker site stops serving older days. Each day it fetches becomes a recorded day.
_Avoid_: Backfill (that is filling gaps in the live tape)

**Trade fields**:
A running trade's time, stock code, price, lots, board and aggressor side: what the tape holds for it. The walks that fetch a day's broker codes after the close send each trade's fields with its codes, or its codes alone when its row's fields aren't valid.
_Avoid_: Trade details, trade row

**Held trade**:
A trade of a trading day that has its broker codes and its trade fields. The fields come from the day's tape, or, for a trade the tape lacks, from a walk after the close; a trade the tape holds always uses the tape's fields, and for one it lacks, the first walk's fields are kept. On a day the relay recorded, fields from a walk never join the tape or anything Market Live shows; a day whose tape source is the walks takes their fields as its tape until it is sealed, and once buildable becomes a recorded day. Once a day is sealed, whatever its tape source, a walk's fields of a trade its tape lacks hold that trade without joining the tape, as on a day the relay recorded.
_Avoid_: Covered trade (covered counts the cross-check's agreements)

**Tape source**:
Where a trading day's tape comes from, set once and never changed: the relay, when its first trade of the day arrives before 17:00 WIB, or the walks, when a walk sends trade fields for a day the relay sent no trade of. Until either happens it is unknown, and a day whose tape source is unknown is never sealed. The walks fill a day's tape only until it is sealed; a sealed day's tape never changes.
_Avoid_: Tape mode, feed (a feed is one broker site's stream)

**Complete** (a day's broker codes):
Every trade 1..N of the day, N its highest trade number, is a held trade. A day that isn't complete lists its missing trades, tape holes with codes but no walk's fields among them, and the walks fetch those again.
_Avoid_: Done, finished

**Buildable** (a day's broker codes):
N, the day's highest trade number, is known, and at most the **missing allowance**, 1 in 1,000 of its trades 1..N (0.1%), aren't held trades. A sealed buildable day builds its broker totals, and a day whose tape source is the walks seals once buildable. A few trade numbers neither broker site lists never stop a day; a half-walked day never passes for light trading.
_Avoid_: Complete (that allows no missing trade), near complete

**Codes complete**:
Every trade 1..N of the day has broker codes, whatever its fields. It is what Market Live's recorded day reads to show its brokers, and a tape hole doesn't stop it.
_Avoid_: Complete (that also needs every trade's fields)

**Trade number**:
The exchange's number for a running trade: one sequence across the whole market, restarting each trading day. Every feed that reports the same trade gives it the same trade number.
_Avoid_: Trade ID, sequence

**Board**:
The exchange market a running trade happens on: regular, cash, or negotiated. Candles count only regular-board trades.
_Avoid_: Market type

**Settled trade**:
A running trade past the time in which a later copy of it from another feed may still change its side, time or board, so the candle it falls in counts it as it stands. The day store keeps settled trades' candles, and Market Bubbles' bubbles answer holds only settled trades: every one that reached the trading-day Durable Object before the instant it names.
_Avoid_: Final trade, confirmed trade

**Indicative price**:
The price, and the volume with it, that an auction would match at if it closed now. Published only during pre-opening and pre-closing, and shown only while the auction of its time runs: pre-closing shows nothing until its own first frame, never the morning's price.
_Avoid_: IEP, projected price

**Auction match**:
The running trades a pre-opening or pre-closing auction produces when it closes: every stock code at its one matched price, all stamped with the same second. They carry no buy or sell side. After the close, once all of a code's match trades have stored broker codes, its Auction row in the sweep log shows its buyers and sellers. It is never split.
_Avoid_: Crossing, uncross, opening print

**Aggressor side**:
Which side of a running trade crossed the spread to make it: a buy aggressor took a resting offer, a sell aggressor hit a resting bid. Auction matches have none.
_Avoid_: HAKA/HAKI (on the page), trade direction

**Sweep**:
A stock code's running trades in one second that share an aggressor side, taken together: their lots, value, and first and last price. Another code's trades between them don't break it; this code trading on the other side does. Once every trade of the sweep has stored broker codes, it is also split by aggressor broker (the seller of a sell sweep, the buyer of a buy sweep), so each sweep has one aggressor broker; all of one broker's trades in it are one sweep, however interleaved with other brokers' trades.
_Avoid_: Group, burst

**Sweep alert**:
A sweep that reached its stock code's top-1% cutoff for its side, among at least 100 earlier sweeps of that side today, decided live. Market Live plays its side's sound and marks its trades on the tape.

**Top-1% cutoff**:
The lots that a side's biggest 1% of sweeps so far reach.

**Lead broker**:
The broker code with the most lots on a sweep's Other side, or on each side of an auction match, summed over its trades. The sweep log shows it with its investor type, and how many other brokers were on that side. A sweep's aggressor side has one broker, shown alone.
_Avoid_: Top broker (top names the top-N filter), main broker

**Whole sweep**:
A sweep every one of whose trades has stored broker codes. Only a whole sweep shows brokers, and a whole sweep is the one that splits by aggressor broker; a sweep missing any trade's codes shows none and stays unsplit, rather than read from part of it.
_Avoid_: Complete sweep (complete names the day's broker codes status), coded sweep

**Piece**:
One of the sweeps a whole sweep splits into: one aggressor broker's trades of it, with its own lots, value, first and last price, trade count and time, and its first trade's number as its id. A whole sweep with one aggressor broker is one piece; an auction match's entry also holds one piece, though it is no sweep. The sweep log's rows and the candle chart's bubbles show pieces in place of the whole sweeps they came from.
_Avoid_: Split sweep (in code), sub-sweep, part

**Other side**:
The side of a sweep opposite its aggressor side: the sellers a buy sweep took from, or the buyers a sell sweep hit. The sweep log's Other side column shows its lead broker.
_Avoid_: Passive side, counterparty

**Own lots**:
A sweep's lots as the broker filter counts them: its whole lots when the picked broker is its aggressor, or when no broker is picked. An auction match's own lots are the larger of what the picked broker bought or sold in it. Bubbles are sized, and the top-N filter cuts, by own lots.
_Avoid_: Broker lots, filtered lots

**Footprint**:
A candle's lots split by price and aggressor side: at each price it traded, the sell-aggressor lots and the buy-aggressor lots.
_Avoid_: Cluster chart, volume profile (that is the whole day by price)

**Footprint chart**:
Market Live's upper chart: the selected stock code's footprint for each minute, with its delta. It shows a short window of minutes that the candle chart shades.
_Avoid_: Chart 2

**Candle chart**:
Market Live's lower chart: the selected stock code's one-minute candles and volume, its sweeps drawn as bubbles over its book heatmap.
_Avoid_: Chart 1, bubble chart

**Delta**:
Buy-aggressor lots minus sell-aggressor lots, for one candle or one price in it. Its running sum over the trading day is the cumulative delta.
_Avoid_: Net volume

**Book heatmap**:
The order book's resting lots at each price over the trading day, drawn as a shaded band behind the price.
_Avoid_: Liquidity map, depth chart

**Day state**:
A stock code's or index's figures for the trading day so far: last price, previous close, change, open, high, low, volume, value and frequency. The previous close and the change are absent until a frame of the code carries a previous close, which an index's never do; a price seen today never stands in for it.
_Avoid_: Quote, summary

**Order book**:
The resting buy orders (bid) and sell orders (offer) for one stock code, as price levels with their lots and number of orders.
_Avoid_: Depth, market depth

**Net flow**:
Net broker buying minus selling for an instrument over a period, in rupiah, from end-of-day data. Absent when the feed has no coverage.
_Avoid_: Broker flow (for the figure), flow

**Market Bubbles**:
The live map of every stock code as a bubble, sized and coloured by figures over a window, grouped by sector.
_Avoid_: Heatmap, bubble chart

**Window**:
The span of trading a bubble's figures cover: the last 30 seconds, the current minute plus the minutes before it (1m, 5m, 15m, 30m, 1h), or the day so far (D). Out of session it ends at the day's last trade.
_Avoid_: Timeframe, period

**Buy/Sell delta %**:
Buy-aggressor value minus sell-aggressor value, over their sum, for one stock code or sector in a window. It is in rupiah, unlike Delta, which is in lots.
_Avoid_: Net flow, delta (alone)

**Sector**:
A stock code's IDX-IC sector, from IDX's company profiles; Unclassified when IDX lists none for it.
_Avoid_: Industry (for the top level), category

**Broker inventory**:
One broker code's running sum of net lots or value (bought minus sold) in one stock code, day by day from the start of a range of days, counting regular-board trades and auction matches. A day counts once it is buildable: at most 0.1% of its trades lack stored broker codes or their stock code, price, lots and board, from the running trades or the broker site's own listing. Any other day is a gap day the sum carries across, and the trades a counted day missed are shown beside the sums.
_Avoid_: Position, holdings (those are what KSEI reports), net flow

**Broker summary**:
Each broker code's lots and value bought and sold in one stock code over a range of days, its net, its average buy and sell price weighted by lots, and its Freq, from the same trades broker inventory counts.
_Avoid_: Broker ranking, done summary

**Broker totals**:
One day's lots, value and trades each broker code bought and sold in each stock code, by investor type, with each code's daily candle and the day's count of missing trades, built from its held trades once the day is sealed and buildable. Broker inventory and the broker summary sum them over a range.
_Avoid_: Running sums (totals are per day)

**Freq**:
The trades on the side a broker code leans over a range of days: the trades it bought in when its net lots are 0 or more, the trades it sold in otherwise. A trade between two sides of one broker code and investor type counts once on each side.
_Avoid_: Frequency (on its own), trade count

**Built day**:
A day whose broker totals are written whole, with the build version that wrote them. A day of a range without one is a gap day, whatever rows it holds.
_Avoid_: Recorded day (that is the tape and its answers)

**Gap day**:
A day of a range with no built day: not yet buildable, or a built day a later batch pushed past the missing allowance, whose broker totals are cleared until it is buildable again. Broker inventory carries its sums across it and the broker summary skips it.
_Avoid_: Incomplete day (a counted day can miss trades too), relay gap (that is a stretch of the live tape)

**Stale day**:
A built day that a later batch corrected, by changing a trade's kept broker codes, filling a trade's fields, or raising N. Its old broker totals stay readable until it is rebuilt, once a quiet spell has passed since the last such batch, or cleared, a gap day, if it is no longer buildable by then.
_Avoid_: Dirty day, outdated day

**Reconcile**:
The daily pass after the seal that pokes each listed day the broker totals DB holds unbuilt or built by an older build version, newest first, until a day's quota of them have accepted. A poke builds a sealed, buildable day; a day that answers it won't takes no slot.
_Avoid_: Backfill (that is the relay's REST fetch of missed trades)

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
One pass that compares IDX's list of shareholding reports with the shareholding archive and stores any report, or new version of one, that the archive lacks. The schedule starts one twice a day, and an admin can start one when none is in progress. It ends **complete**, **partial** (some reports could not be stored, and wait for the next run) or **failed** (IDX's list could not be read).
_Avoid_: Sync, scrape, job

### KSEI

**KSEI report**:
One monthly zip KSEI publishes on its Statistik Efek or Kepemilikan Efek page, covering one month up to its period end. It is kept exactly as published.
_Avoid_: KSEI file, Balancepos file

**KSEI report kind**:
Which of KSEI's two monthly reports a file is: **Securities statistics** (Statistik Efek) or **Securities holdings** (Kepemilikan Efek, holdings by investor type).
_Avoid_: Report kind, which is IDX's

**KSEI archive**:
Every KSEI report the dashboard has kept, each version of it included. Nothing in it is ever overwritten or removed. It is separate from the shareholding archive.
_Avoid_: KSEI mirror, shareholding archive

**KSEI archive run**:
One pass that compares KSEI's lists of reports with the KSEI archive and stores any report, or new version of one, that the archive lacks. The schedule starts one each day, and an admin can start one when no KSEI archive run is in progress. It ends **complete**, **partial** (a list or some reports could not be read or stored, and wait for the next run) or **failed** (neither list could be read).
_Avoid_: Archive run, which is IDX's; sync, scrape

**Deep backfill**:
A KSEI archive run an admin starts that also looks for KSEI reports older than KSEI's lists, by filenames known from elsewhere and by guessing each month's period end. Scheduled runs never do this.
_Avoid_: History run, full sync

**Run**:
One pass of either archive (an archive run or a KSEI archive run) or one parse run (a classification parse run, an investor-type parse run, an above-1% parse run or a KSEI parse run). What they share (a run id, its outcome, one run of each in progress at a time) is said of a run.
_Avoid_: Archive run for both, which is IDX's; job

### Holdings

**Parsed holdings**:
What the dashboard has read out of its archived holdings reports, one set of rows per report date: the newest archived version of a month replaces the older one whole, so a month is never read half old and half new.
_Avoid_: Holdings database, parsed data

**Parse failure**:
A month a parse run picked to parse but couldn't: most often its archived report doesn't match what the parser expects, such as an unknown header or a row whose holdings don't add up to its total, but also its report missing from the archive, or the parsed holdings unwritable after retries. Nothing of it is stored: the month keeps its earlier parsed holdings, or stays absent, and the next run tries it again.
_Avoid_: Parse error, bad month

**Investor classification**:
One of the 39 categories a KSEI account holder assigns an investor through know-your-customer checks, such as Mutual funds, Pension funds or Individual.
_Avoid_: Investor type, which is KSEI's 9

**Origin**:
Whether holdings are **local**, **foreign**, or **combined**. A month whose report doesn't split local from foreign (IDX's classification reports before September 2026) has combined holdings only; a split month also has combined, their sum.
_Avoid_: Domicile

**Classification holding**:
One stock's scripless shares held by one investor classification and origin, as of a classification report's data date. A classification and origin with no holding holds 0.
_Avoid_: Ownership row, class holding

**KSEI holding**:
One stock's scripless shares held by one of KSEI's 9 investor types and one origin, local or foreign, as of a Securities holdings report's period end. Every equity in the report has them, priced or not. A type and origin with no holding holds 0.
_Avoid_: Balancepos row, type holding

**Investor-type holding**:
One stock's scripless shares held by one KSEI investor type and origin, split into ≥5% holders and <5% holders, as of an investor-type report's data date. A type and origin with no holding holds 0 in both.
_Avoid_: Type holding, which reads as KSEI's; band row

**KSEI investor type**:
One of KSEI's 9 parent categories of investor: ID (Individual), CP (Corporate), MF (Mutual fund), IB (Financial institution), IS (Insurance), SC (Securities company), PF (Pension fund), FD (Foundation) and OT (Others). The stock page groups investor classifications into them by a fixed mapping, which never matches KSEI's own type totals exactly.
_Avoid_: Investor group, category

**Classification parse run**:
One pass that parses each holdings-by-investor-classification report in the shareholding archive whose newest version, or the parser's version, hasn't been parsed into classification holdings. The schedule starts one each day, an hour after the evening archive run, and an admin can start one when none is in progress. It ends **complete**, **partial** (some months could not be parsed and wait for the next run) or **failed**.
_Avoid_: Archive run, which stores reports; import, sync

**Investor-type parse run**:
The same pass for holdings-by-investor-type reports, parsed into investor-type holdings, on its own schedule and in its own progress. It ends **complete**, **partial** or **failed** as a classification parse run does.
_Avoid_: Archive run; IDX parse run

**Above-1% parse run**:
The same pass for holders-above-1% reports, parsed into ≥1% holders, on its own schedule and in its own progress. It ends **complete**, **partial** or **failed** as a classification parse run does.
_Avoid_: Archive run; holder parse run

**KSEI parse run**:
One pass that parses each Securities holdings report in the KSEI archive whose newest version, or the parser's version, hasn't been parsed into KSEI holdings, from November 2018 on. The schedule starts one each day, an hour after the KSEI archive run, and an admin can start one when no KSEI parse run is in progress. A report that doesn't read exactly as expected is rejected whole and keeps the month's earlier holdings. It ends **complete**, **partial** (some months could not be parsed and wait for the next run) or **failed**.
_Avoid_: KSEI archive run, which stores reports; import, sync

**Parse coverage**:
Each archived month a parse run reads, of a Report kind or a KSEI report kind, and how far it is parsed: **parsed** (from its newest version, by the current parser), **stale** (from an older version or by an older parser, so the next parse run parses it again), **failed** (the last finished parse run had a parse failure on it), or **not parsed yet** (never parsed). A failed month may still have its earlier parsed holdings.
_Avoid_: Coverage, which is the KSEI archive's held months; parse status

**Retail / institution**:
Retail is the holdings of the Individual KSEI investor type; institution is every other type's.
_Avoid_: Retail investors meaning any small holder

**Scripless / scrip shares**:
Scripless shares are a stock's shares held electronically in KSEI accounts, the shares every holding counts. Scrip shares are the rest of its listed shares, still held as paper certificates: listed shares less scripless shares, both from the same report. Shareholders composition takes listed shares from KSEI's Securities holdings report of the same date, and without one, scrip is unavailable. Holder size takes them from the investor-type report's shares outstanding. Major holders counts each ≥1% holder's scrip, from the above-1% report, so its percentages are of listed shares, scrip included.
_Avoid_: Free float, which is a different measure

**Stock page**:
The page of one stock, `/stocks/<code>`, open to every signed-in member: who holds the stock, from parsed holdings.
_Avoid_: Ownership page, stock detail

**Shareholders composition**:
The stock page's panel of one classification report month: the stock's total scripless shares, scrip against scripless, retail against institution, and each KSEI investor type's share of an origin, against the month before.
_Avoid_: Ownership mix, holder breakdown

**Holder size**:
The stock page's panel that splits a stock's shares between ≥5% holders, <5% holders and scrip, for the whole stock and for each KSEI investor type, one investor-type report month against the month before, or across every month the stock has. Its local/foreign split is IDX's.
_Avoid_: Ownership concentration, block holders

**≥5% holders / <5% holders**:
A ≥5% holder is one investor holding at least 5% of a stock's shares outstanding in scripless form; every other holder is a <5% holder. IDX's investor-type report splits each investor type's holding between the two. A large holder's stake spread over several types can count partly as <5%, so the split by type is approximate.
_Avoid_: Minor holders, insiders, block holders

**Major holders**:
The stock page's panel that lists a stock's ≥1% holders for one above-1% report month, each against the month before, with the stock's listed shares split among them, and every holder's share across every month the stock has.
_Avoid_: Shareholder list, top holders, ≥5% holders (Holder size's band)

**≥1% holder**:
One investor IDX lists as holding at least 1% of a stock's listed shares, scrip included, as of an above-1% report's data date. The report names each holder, sometimes on several rows; rows whose names match once case, punctuation, legal forms, titles and word order are ignored count as one holder, summed. A holder can still appear under an unrelated name from one month to the next, so a few look like one leaving and another arriving.
_Avoid_: Major holder, shareholder, ≥5% holder (scripless, of shares outstanding)

**Off list**:
A ≥1% holder listed in the month before and not in this one: it sold out or fell below 1%, which the report can't tell apart.
_Avoid_: Exited, sold

**Controller**:
A ≥1% holder IDX marks as a listed company's controller, or as an affiliate of the controller, from the company's own monthly report for the month before. Marked from Oct 2026 on.
_Avoid_: Owner, insider, majority holder

**Holding composition**:
The stock page's chart of the stock's KSEI holdings, one column per month from its first period end to its last, with a month KSEI has no data for marked: local against foreign, or one origin's KSEI investor types. Every share is of the whole origin, even with some types hidden. Its local/foreign split can differ from Shareholders composition's, which is IDX's.
_Avoid_: Ownership chart, holding history

**Stock search**:
The search in the Shell header, on every page, that opens a stock page. It offers the stocks parsed holdings have, code matches before issuer-name matches, and `/` focuses it. Bare `/stocks` opens the stock page this browser last opened.
_Avoid_: Code picker, which picks Market Live's code

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
The frame around every page: sidebar, header, and mobile bottom bar. It reads no market data except the stock search's list of stocks.
