---
name: KUMORA Terminal
description: The IDX market terminal, a night desk for following the smart money.
colors:
  bg-canvas: "#0b1421"
  bg-sidebar: "#0e1a29"
  bg-surface: "#142234"
  bg-elevated: "#1b2c40"
  bg-selected: "#173a43"
  border-subtle: "#26394e"
  border-strong: "#3e566b"
  text-primary: "#edf4fb"
  text-secondary: "#b0c2d2"
  text-muted: "#839aae"
  accent-primary: "#55d9c7"
  accent-hover: "#7be6d8"
  accent-on-primary: "#09242a"
  semantic-up: "#51dda2"
  semantic-down: "#ff7987"
  semantic-warning: "#f4c36e"
  semantic-info: "#7dbcf5"
  semantic-neutral: "#a8b8c8"
  chart-vwap: "#b3a0ff"
  chart-volume: "#627f9b"
  chart-grid: "#26384b"
  chart-imbalance-buy: "#6fe3ff"
  chart-imbalance-sell: "#ff8cf0"
  chart-vwap-band-2: "#9ad96c"
typography:
  display:
    fontFamily: "Manrope Variable, Arial, sans-serif"
    fontSize: "28px"
    fontWeight: 650
    lineHeight: "34px"
    fontFeature: "tnum"
  headline:
    fontFamily: "Manrope Variable, Arial, sans-serif"
    fontSize: "24px"
    fontWeight: 700
    lineHeight: "32px"
  title:
    fontFamily: "Manrope Variable, Arial, sans-serif"
    fontSize: "15px"
    fontWeight: 600
    lineHeight: "22px"
  body:
    fontFamily: "Manrope Variable, Arial, sans-serif"
    fontSize: "14px"
    fontWeight: 400
    lineHeight: "22px"
  control:
    fontFamily: "Manrope Variable, Arial, sans-serif"
    fontSize: "13px"
    fontWeight: 500
    lineHeight: "18px"
  label:
    fontFamily: "Manrope Variable, Arial, sans-serif"
    fontSize: "12px"
    fontWeight: 450
    lineHeight: "18px"
  micro:
    fontFamily: "Manrope Variable, Arial, sans-serif"
    fontSize: "11px"
    fontWeight: 500
    lineHeight: "16px"
    letterSpacing: "0.04em"
  data:
    fontFamily: "JetBrains Mono Variable, ui-monospace, monospace"
    fontSize: "12px"
    fontWeight: 400
    lineHeight: "18px"
rounded:
  xs: "4px"
  sm: "6px"
  md: "10px"
  lg: "14px"
  xl: "18px"
  full: "9999px"
spacing:
  "1": "4px"
  "1.5": "6px"
  "2": "8px"
  "3": "12px"
  "4": "16px"
  "6": "24px"
components:
  button-primary:
    backgroundColor: "{colors.accent-primary}"
    textColor: "{colors.accent-on-primary}"
    typography: "{typography.control}"
    rounded: "{rounded.sm}"
    padding: "0 12px"
    height: "36px"
  button-primary-hover:
    backgroundColor: "{colors.accent-hover}"
  button-secondary:
    backgroundColor: "{colors.bg-surface}"
    textColor: "{colors.text-primary}"
    typography: "{typography.control}"
    rounded: "{rounded.sm}"
    padding: "0 12px"
    height: "36px"
  button-secondary-hover:
    backgroundColor: "{colors.bg-elevated}"
  button-ghost:
    textColor: "{colors.text-secondary}"
    typography: "{typography.control}"
    rounded: "{rounded.sm}"
    padding: "0 12px"
    height: "36px"
  button-danger:
    textColor: "{colors.semantic-down}"
    typography: "{typography.control}"
    rounded: "{rounded.sm}"
    padding: "0 12px"
    height: "36px"
  chip:
    backgroundColor: "{colors.bg-surface}"
    textColor: "{colors.text-secondary}"
    rounded: "{rounded.full}"
    padding: "0 12px"
    height: "28px"
  chip-selected:
    backgroundColor: "{colors.bg-selected}"
    textColor: "{colors.text-primary}"
  input:
    backgroundColor: "{colors.bg-canvas}"
    textColor: "{colors.text-primary}"
    typography: "{typography.control}"
    rounded: "{rounded.sm}"
    padding: "0 12px"
    height: "36px"
  card:
    backgroundColor: "{colors.bg-surface}"
    textColor: "{colors.text-primary}"
    rounded: "{rounded.md}"
    padding: "16px"
  badge:
    backgroundColor: "{colors.bg-elevated}"
    typography: "{typography.label}"
    rounded: "{rounded.xs}"
    padding: "0 8px"
    height: "20px"
  status-pill:
    backgroundColor: "{colors.bg-elevated}"
    typography: "{typography.micro}"
    rounded: "{rounded.full}"
    padding: "0 8px"
    height: "22px"
  nav-item-active:
    backgroundColor: "{colors.bg-selected}"
    textColor: "{colors.text-primary}"
    rounded: "{rounded.sm}"
    height: "36px"
  dialog:
    backgroundColor: "{colors.bg-elevated}"
    textColor: "{colors.text-primary}"
    rounded: "{rounded.xl}"
    padding: "24px"
    width: "440px"
---

# Design System: KUMORA Terminal

## Overview

**Creative North Star: "The Night Desk"**

KUMORA is a trading desk after dark. The trader sits with it through a whole IDX session, so the room is low-glare navy, the lamps are dim, and the one teal signal on the desk is reserved for what the trader can act on: the primary action, the active page, the focused control. Everything else is quiet so that the flow reads: green and red mean buy and sell or up and down, amber and blue mean foreign and domestic, and nothing decorative borrows those meanings.

Every figure sits on a fixed grid. Prices, lots, rupiah and times use tabular figures, so a column of numbers stays still while it updates. Every live-looking value says where it came from and how fresh it is (LIVE, DELAYED, STALE, RECORDED, with the WIB time). A missing value shows "—", never zero. The desk is honest before it is pretty.

Density is that of a working tool, not a showcase: 13px controls, 14px body, uppercase 11px micro-labels for section and status names, and compact 32–40px controls. The shadcn primitives in `packages/ui` are the base; the dashboard's `K` kit (`src/components/k/`) restyles them into this system. Dark is the only theme.

**Key Characteristics:**

- Navy canvas stepped up by tone, with hairline borders; flat.
- One teal accent, used only for the primary action, the active state and focus.
- Semantic color is reserved: up/down, foreign/domestic, freshness, chart series.
- Tabular figures everywhere a number can change.
- Provenance and freshness beside every live value.
- Compact, quiet controls with small radii.

## Colors

A cool, low-chroma navy ground (hue ≈255) with a single teal accent and a reserved set of semantic hues. Values are hex custom properties on `:root` in `apps/dashboard/src/styles.css`; shadcn's variables alias them.

### Primary

- **Teal** (`accent-primary`, #55d9c7): the primary button fill, the active nav icon, the focus outline (`--ring`), the selected chip border, the "Terminal" half of the wordmark. **Teal hover** (`accent-hover`, #7be6d8) is its hover. Text on it is **On-teal** (`accent-on-primary`, #09242a).

### Neutral

- **Canvas** (`bg-canvas`, #0b1421): the page ground, input fields, and the blurred header (at 82% opacity).
- **Sidebar** (`bg-sidebar`, #0e1a29): the sidebar.
- **Surface** (`bg-surface`, #142234): cards, chips, secondary buttons.
- **Raised** (`bg-elevated`, #1b2c40): hover fills, badges, status pills, popovers, tooltips, dialogs.
- **Selected** (`bg-selected`, #173a43): the selected row, chip and nav item; a navy pulled toward the teal.
- **Border** (`border-subtle`, #26394e) for card and section edges; **Strong border** (`border-strong`, #3e566b) for control borders (inputs, chips, secondary buttons).
- Text: **Primary** (`text-primary`, #edf4fb), **Secondary** (`text-secondary`, #b0c2d2) for labels and inactive nav, **Muted** (`text-muted`, #839aae) for hints, units, provenance lines and placeholders.

### Semantic

- **Up green** (`semantic-up`, #51dda2) and **Down red** (`semantic-down`, #ff7987): price up/down, buy/sell aggressor on the tape, positive/negative delta. Down red is also the error and destructive color.
- **Amber** (`semantic-warning`, #f4c36e): warnings, DELAYED and STALE, and **foreign** investors on the tape.
- **Blue** (`semantic-info`, #7dbcf5): info, EOD and RECORDED, and **domestic** investors on the tape.
- **Neutral gray** (`semantic-neutral`, #a8b8c8): flat change, neutral badges, demo data.

### Chart

- **VWAP violet** (`chart-vwap`, #b3a0ff), **Volume gray** (`chart-volume`, #627f9b), **Grid** (`chart-grid`, #26384b).
- Footprint: **Imbalance cyan** (#6fe3ff) for buy and **Imbalance magenta** (#ff8cf0) for sell; the day VWAP in Blue with its ±1σ/±2σ/±3σ bands in Up green, Lime (#9ad96c) and Amber.
- Market Bubbles reuse up/down/neutral for each bubble's rim and glow, with the canvas as the core.
- Holdings: nine fixed KSEI investor-type colors (`--investor-*`) and local/foreign (`--origin-local` violet, `--origin-foreign` rose), defined in `styles.css`. They belong to the stock page's holdings charts only.

### Named Rules

**The Teal Rule.** Teal marks what the trader can act on now (primary action, active page, focus, selection) and nothing else. It never colors data.

**The Reserved Colors Rule.** Green/red mean up/down or buy/sell; amber/blue mean foreign/domestic (with the `[F]`/`[D]` cue beside the broker code so no meaning rests on color alone). A new feature may not reuse these hues for decoration or for a different meaning.

## Typography

**Body Font:** Manrope Variable (with Arial, sans-serif), for everything including figures.
**Data Font:** JetBrains Mono Variable, only on the archive admin pages (run ids, file names, key prefixes, month grids), where a long id must read character by character.

Note: `--font-mono` is deliberately Manrope. The `num` utility sets `font-family: var(--font-mono)` plus `font-variant-numeric: tabular-nums`, so market figures stay in Manrope with fixed-width digits.

### Hierarchy

- **Display** (650, 28px/34px, tabular): the headline figure of a metric card. Compact metrics use 20px/28px semibold.
- **Headline** (700, 24px/32px): the page h1 ("Market Live", "Account"). One per page. Auth pages use 20px semibold.
- **Title** (600, 15px/22px): section and panel titles; the wordmark uses 15px extrabold.
- **Body** (400, 14px/22px): the base text on `body`.
- **Control** (500, 13px/18px): buttons, inputs, chips, nav (13.5px), breadcrumbs, table cells.
- **Label** (450, 12px/18px): field labels, metric labels, hints, provenance lines.
- **Micro** (500, 11px/16px, uppercase, 0.04em tracking): the `micro` utility; status pills, column and section labels. The sidebar's group labels go smaller still (10px, 0.16em tracking).

### Named Rules

**The Tabular Figures Rule.** Any number that can change while the user watches (price, lots, rupiah, percent, time, count) carries `num` (tabular figures) and right-aligns in tables.

## Layout

- **Shell:** sidebar 244px at ≥1280px, a 64px icon rail at 768–1279px, hidden below 768px where a bottom nav takes over. The header is 56px, sticky, Canvas at 82% with a 16px backdrop blur, holding breadcrumbs, stock search and the WIB clock. An impersonation banner can push both down (`--banner-h`).
- **Spacing:** a 4px base. Gaps of 4, 8 and 12px inside components, 16px card padding and grid gaps, 24px dialog padding and page sections.
- **Density:** controls are 32 (sm), 36 (md) or 40px (lg) tall; inputs default to 36px. Tables have a density option; the first (stock code) column can stick on horizontal scroll.
- **Desktop first:** the scene is a desktop browser left open all session; mobile works but is secondary.

## Elevation & Depth

Tonal and flat. Depth comes from stepping the navy up (canvas → sidebar → surface → elevated) and from 1px hairline borders, never from shadows on resting content. Shadows exist only for things that float over the data:

- **Popover shadow** (`0 4px 16px rgba(4,10,18,0.45)`): tooltips, menus, popovers.
- **Modal shadow** (`0 16px 48px rgba(4,10,18,0.6)`): dialogs.

### Named Rules

**The Flat Cards Rule.** Cards, panels and tables sit flat on the desk: tone plus a hairline border, no shadow. A shadow means "this is floating above the data and will go away."

## Shapes

A fixed radius scale (overriding shadcn's `calc()` radii on purpose): 4px (xs) for badges, tooltips and kbd hints; 6px (sm) for buttons, inputs and nav items; 10px (md) for cards and empty states; 18px (xl) for dialogs; full for chips, status pills and status dots. Corners stay small: these are instruments, not pillows. Borders are always 1px; a dashed border means "not real yet" (a reset chip, an empty state, demo data).

## Components

The kit lives in `apps/dashboard/src/components/k/` (`KButton`, `KChip`, `KBadge`, `KStatusPill`, `KInput`, `KSelect`, `KMetricCard`, `KDataTable`, `KDialog`, `KEmptyState`, `KSourceLine`, `Delta`, `KTooltip`, `KSkeleton`). New screens compose these rather than raw shadcn primitives.

### Buttons

Precise and quiet.

- **Shape:** small radius (6px); 32/36/40px tall; 18px line height; Tabler icons at stroke 1.75.
- **Primary:** Teal fill, On-teal text; hover brightens to Teal hover.
- **Secondary:** Surface fill, strong border, primary text; hover goes to Raised.
- **Ghost:** secondary text, no fill; hover fills Raised and lifts the text to primary.
- **Danger:** outlined in Down red, transparent fill, Down red text; never a filled red block.
- **Focus:** a 2px Teal outline offset 2px (`kFocus`), replacing shadcn's ring.
- **Loading:** a spinner replaces the icon, the button is disabled and `aria-busy`. Disabled is 50% opacity.
- **Icon button:** square, ghost by default, with its label as both accessible name and tooltip.

### Chips

- **Style:** 28px pills, Surface fill, strong border, secondary text at 13px weight 450, an optional count in muted tabular figures.
- **State:** selected chips get a Teal border, Selected fill and primary text. A removable chip splits off its × as a sibling button. A dashed chip is the "Reset" action.

### Cards / Containers

- **Corner Style:** 10px.
- **Background:** Surface with a 1px border, 16px padding, no shadow.
- **Metric card:** a label row with an optional status pill, the display figure (with a muted unit), a `Delta` line, then the provenance line. A STALE card gets an amber border and dims its figure to secondary text.

### Inputs / Fields

- **Style:** Canvas fill (darker than the card it sits on), strong border, 6px radius, 13px text. A label always sits above (12px secondary text); placeholders never replace it.
- **Focus:** the border turns Teal; no glow.
- **Error / Disabled:** Down red border and a Down red message under the field; disabled is 50% opacity. An optional leading icon and a `kbd` shortcut hint sit inside.

### Navigation

- **Sidebar:** grouped links with 10px uppercase group labels; 36px items, secondary text, muted 18px icons. Hover fills Raised. Active fills Selected, makes the text semibold primary text and turns the icon Teal. Items can carry a small teal pill badge, a count, or an amber dot. The foot shows the market-hours box and the decision-support disclaimer.
- **Header:** breadcrumbs (last crumb semibold primary text), stock search, WIB clock.
- **Mobile:** a bottom nav replaces the rail below 768px.

### Status Pill (signature)

The freshness pill beside every live-looking value: 22px, fully rounded, Raised fill, an uppercase 11px label with a 6px dot in the current color. LIVE is Up green, DELAYED and STALE Amber, EOD and RECORDED Blue, UNAVAILABLE Down red, and DATA DEMO a dashed Neutral gray. It can carry a detail ("DELAYED · 17m"), a source ("· extension") and the WIB time, and its tooltip states the reason and definition.

### Provenance Line and Delta (signature)

`KSourceLine` sets the "source · per 14.45 WIB" line in 12px muted text under any live value. `Delta` renders a signed change as an arrow, sign and color plus a screen-reader word, and "—" for no value.

### Data Table

- **Structure:** `KDataTable` on Surface cells with a border along the bottom per row; the last row has none. Headers are 36px, 12px weight 450 muted text on Surface; the active sort column's header turns primary text.
- **Cells:** built-in formats (`pct` as a `Delta`, `idr`, `compactIdr` signed up/down, `shares`, `ticker`, `status` as a pill, `asOf`). Numeric kinds right-align with tabular figures; a null cell shows "—". The `ticker` cell is the stock code in 650 weight with the company name under it in 11px secondary text.
- **Sort:** a small chevron beside the label, 40% opacity when idle, Teal when active, rotated for descending; `aria-sort` is set.
- **Rows:** hover fills Raised, a selected row Selected. Clickable rows take keyboard focus with the teal outline drawn inside the row.
- **Header notes:** a column's methodology note opens as an "explain" tooltip.
- **States:** loading, empty, restricted and error replace the body through `KStateBody`; a ready table with no rows shows the `no-result` empty state.

### Ticker Row

- **Use:** a watchlist row: stock code and name, last price, change, volume, freshness pill.
- **Density:** compact 36px (13px text), comfortable 44px (14px), or a card form on mobile (Surface, 10px radius, 12px padding) with the same cells in the same order.
- **Selected:** Selected fill plus a 2px Teal bar on the left edge (inset shadow).

### Running Trade Tape (signature)

- **Rows:** fixed 22px rows, virtualized, every value tabular. Price, lots and value take the aggressor's color (Up green for buy, Down red for sell); the side is also given as screen-reader text.
- **Broker codes:** each side reads `AK [F]`, colored Amber for foreign or Blue for domestic; the bracketed letter carries the meaning without color.
- **Big trades:** a row worth at least Rp1 B is tinted at 15% of its side's color with a 3px inset bar of that color on the left.
- **Sweep alerts:** a ▲ or ▼ in the side's color marks an alerted trade.
- **Auction matches:** the opening and closing match rows fold into a Blue band at 10% tint.
- **Feeds:** small dots show which feed saw each trade; a stale tape drops to 50% opacity rather than disappearing.

### Select

- **Style:** the same field shell as inputs (Canvas, Strong border, 6px, 13px) at 32, 36 or 40px, with a muted chevron. A label always sits above.
- **Menu:** Raised popover, 1px border, 6px radius, popover shadow; the highlighted item fills Selected.

### Toast

- **Surface:** 360px wide, Raised, 1px border, 10px radius, popover shadow, 12px × 16px padding.
- **Tone:** a single icon in the tone's color carries the tone (success Up green, info Blue, warning Amber, error Down red); the surface itself stays neutral. Title 13px medium primary text, description 12px secondary text, an optional ghost action, and a dismiss icon button.
- **Timing:** 4s for success and info, 8s for warnings and errors, which are also announced as alerts.

### Tooltip

- **Surface:** Raised, 1px border, 4px radius, popover shadow, 12px text, 160–280px wide, 8px from its trigger.
- **Explain variant:** a 2px Blue rule on the left and a Blue title line, for methodology notes.
- **Rule:** a critical figure never lives only inside a tooltip.

### Skeleton

- **Style:** Raised bars with a 4px radius, shaped like the element they stand in for (text, metric card, table rows, chart), with `aria-busy`. The pulse stops under reduced motion.

## Do's and Don'ts

### Do:

- **Do** compose new screens from the `K` kit, and add a variant to it before styling a one-off.
- **Do** put `num` on every changing figure and right-align numeric table columns.
- **Do** show freshness (`KStatusPill`) and provenance (`KSourceLine`) beside every live-looking value, and render a missing value as "—".
- **Do** keep depth tonal: Surface cards with a 1px border on the Canvas.
- **Do** pair every semantic color with a non-color cue: an arrow on a delta, `[F]`/`[D]` on a broker code, an icon on a badge.
- **Do** use the 2px Teal focus outline (`kFocus`) on every interactive element.

### Don't:

- **Don't** use Teal for data, charts or decoration.
- **Don't** reuse green, red, amber or blue for anything except their reserved meanings.
- **Don't** put shadows on resting cards or panels.
- **Don't** fill destructive buttons with red; outline them in Down red.
- **Don't** render missing data as 0.
- **Don't** add a light theme or light surfaces; dark is the only theme.
- **Don't** set market figures in JetBrains Mono; it is for archive ids and grids only.
