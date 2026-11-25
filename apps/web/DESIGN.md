---
name: KUMORA Web
description: The market printed like an Indonesian bank passbook.
colors:
  cloth: "#1b3b78"
  cloth-deep: "#132c5c"
  cloth-thread: "#24488c"
  foil: "#e9eef8"
  foil-dim: "#b9c6de"
  paper: "#e4eee7"
  paper-edge: "#d3e0d7"
  rule: "#9fb8aa"
  ticket-stock: "#fbfcf9"
  ink: "#241d30"
  ink-soft: "#4b4458"
  ink-faint: "#6d6679"
  stamp: "#6a3b9c"
  up: "#146b40"
  down: "#a8202b"
typography:
  display:
    fontFamily: "Archivo Variable, Arial Narrow, Arial, sans-serif"
    fontSize: "clamp(2.4rem, 5.4vw, 4.4rem)"
    fontWeight: 850
    lineHeight: 0.98
    letterSpacing: "-0.025em"
    fontVariation: "'wdth' 112"
  headline:
    fontFamily: "Archivo Variable, Arial Narrow, Arial, sans-serif"
    fontSize: "clamp(1.75rem, 3.2vw, 2.6rem)"
    fontWeight: 800
    lineHeight: 1.06
    letterSpacing: "-0.015em"
    fontVariation: "'wdth' 108"
  title:
    fontFamily: "Archivo Variable, Arial Narrow, Arial, sans-serif"
    fontSize: "15px"
    fontWeight: 750
    letterSpacing: "0.06em"
    fontVariation: "'wdth' 85"
  body:
    fontFamily: "Archivo Variable, Arial Narrow, Arial, sans-serif"
    fontSize: "17px"
    fontWeight: 400
    lineHeight: 1.6
  label:
    fontFamily: "Archivo Variable, Arial Narrow, Arial, sans-serif"
    fontSize: "11px"
    fontWeight: 750
    lineHeight: "16px"
    letterSpacing: "0.12em"
    fontVariation: "'wdth' 78"
  print:
    fontFamily: "Doto Variable, Courier New, monospace"
    fontSize: "15px"
    fontWeight: 800
    lineHeight: "24px"
    letterSpacing: "0.02em"
    fontFeature: "'tnum'"
  print-queue-number:
    fontFamily: "Doto Variable, Courier New, monospace"
    fontSize: "64px"
    fontWeight: 900
    lineHeight: 1
    letterSpacing: "0.04em"
rounded:
  head: "2px"
  sheet: "3px"
  spread: "4px"
spacing:
  gutter-phone: "16px"
  gutter-tablet: "24px"
  gutter-desktop: "40px"
  sheet-x-phone: "20px"
  sheet-x: "40px"
  section-gap-phone: "56px"
  section-gap: "80px"
  frame: "1240px"
components:
  button-primary:
    backgroundColor: "{colors.cloth}"
    textColor: "{colors.foil}"
    typography: "{typography.title}"
    rounded: "{rounded.sheet}"
    padding: "0 20px"
    height: "48px"
  button-primary-hover:
    backgroundColor: "#21468c"
  input-ledger:
    backgroundColor: "transparent"
    textColor: "{colors.ink}"
    typography: "{typography.print}"
    padding: "0 4px"
    height: "48px"
  sheet:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.ink}"
    rounded: "{rounded.sheet}"
    padding: "56px 40px"
  stamp:
    backgroundColor: "transparent"
    textColor: "{colors.stamp}"
    rounded: "{rounded.sheet}"
    padding: "4px 6px 3px"
  print-head:
    backgroundColor: "{colors.ink}"
    textColor: "{colors.paper}"
    typography: "{typography.print}"
    rounded: "{rounded.head}"
    padding: "4px 8px"
  queue-ticket:
    backgroundColor: "{colors.ticket-stock}"
    textColor: "{colors.ink}"
    padding: "16px 20px 20px"
    width: "22rem"
---

# Design System: KUMORA Web

## Overview

**Creative North Star: "The Market Passbook"**

The public site is an Indonesian bank passbook lying open on its cobalt cloth cover. Every trade is a dot-matrix line in ribbon ink with the broker who bought and the broker who sold; the bank's own pre-printed form sits underneath in cobalt; the teller's violet rubber stamp marks what matters. Nothing glows and nothing floats: depth is paper on cloth, ink on paper, and a ticket torn from a queue machine.

Two type voices carry the whole system. Archivo, pushed wide for headings and narrow for form labels, is the bank's printed stationery. Doto is the printer: one size for every ledger line, with rank made by striking harder, reversing, or stamping, never by printing bigger. Color is scarce and assigned by material: cobalt is cloth and form ink, violet is stamp ink, green and red are reserved for prices.

The page is calm where the passbook is calm (wide paper, generous sheet padding) and live where the market is live: one line prints every 520 ms under a moving print head, and the newest line is always the darkest.

**Key Characteristics:**
- Cobalt cloth ground with a woven thread texture; pale green security paper sheets with a tiling guilloche.
- Two faces: Archivo Variable (width axis) for the form, Doto Variable for every printed entry.
- One ledger print size; rank by double-strike, reversal, underline and stamps.
- Cobalt form ink for pre-printed headers and column rules, ribbon ink for entries.
- Violet rubber stamps with uneven inking; green and red only on prices.
- Motion is the printer's: line print, carriage, stamp-down, ticket-out. All of it is decoration on a readable still frame.

## Colors

A cloth-and-paper palette: one saturated cobalt for the cover and the form, one pale green paper, an aubergine-black ribbon ink, and three spot inks with fixed jobs.

### Primary
- **Passbook Cobalt** (cloth): the cover cloth behind every sheet, the primary button, and, at 25 to 60% opacity, the pre-printed form layer: ledger column headers, column rules, and the heavy rule under a table head.
- **Deep Cloth** (cloth-deep): the cloth's shadow threads and the primary button's pressed lip.
- **Thread Cobalt** (cloth-thread): the lighter crossing threads of the cloth weave only.

### Secondary
- **Teller Violet** (stamp): rubber stamp ink (RECORDED, BIG TRADE, NET BUYER), the focus ring, the input caret, and the text selection tint (28%). It is the only accent allowed to touch interaction.

### Tertiary
- **Price Green** (up) and **Price Red** (down): the price cell of a buy-side or sell-side trade. Red also carries the input's invalid border and the error message, the one place it leaves the price column.

### Neutral
- **Security Paper** (paper): every sheet, the inside of the passbook, the text on reversed lines and the print head.
- **Paper Edge** (paper-edge): the 1 to 2px edge of paper thickness under each sheet.
- **Ruling Green** (rule): dashed row rules, dividers inside sheets, the phone fold.
- **Ticket Stock** (ticket-stock): the near-white thermal paper of the queue ticket only.
- **Ribbon Ink** (ink): headings, ledger entries, reversed-line ground, print head.
- **Soft Ink** (ink-soft): body copy, captions, field label, privacy line.
- **Faint Ink** (ink-faint): the form code colophon (FORM KM-01 · WAITLIST SLIP).
- **Foil** (foil) and **Dim Foil** (foil-dim): type set directly on the cloth (header links, closing heading, footer), as if foil-stamped.

The guilloche artwork (`public/passbook-guilloche.svg`) draws its sine waves in two of its own greens (#b5cdbf, #c8dace) at 0.6 stroke width; it is an asset, not a token.

### Named Rules
**The Prices-Only Rule.** Green and red appear on prices and nowhere else, except red for a form error. Broker codes, lots, values and nets stay in ribbon ink; direction is read from the sign.

**The Two Inks Rule.** Anything pre-printed by the bank (column headers, column rules, table-head rules) is cobalt form ink; anything the machine printed is ribbon ink. Never swap them.

**The Ribbon Fade Rule.** In a running ledger the newest line is darkest; each older line mixes ink toward the paper by 3% per line, capped at 32% so every line stays above 4.5:1. Prices keep their full side ink.

## Typography

**Display Font:** Archivo Variable (with Arial Narrow, Arial)
**Body Font:** Archivo Variable
**Label/Mono Font:** Doto Variable (with Courier New) for printed entries

**Character:** Archivo's width axis does the work a second sans would: wide and heavy (wdth 108 to 112) it is the passbook's cover lettering; narrow (wdth 75 to 92) it is the fine print of a bank form. Doto is a dot-matrix printer face, used only for what a machine printed.

### Hierarchy
- **Display** (850, clamp 2.4 to 4.4rem, 0.98): the hook on the left page. The closing heading on the cloth uses the same voice at clamp(2rem, 4vw, 3.2rem), 1.02, in foil.
- **Headline** (800, clamp 1.75 to 2.6rem, 1.06): section headings on later sheets.
- **Title** (750, 15px, 0.06em, uppercase, wdth 85): the ledger's account line (BBRI · 10 NOV 2026). Index entry names use 750 at 16px, wdth 90.
- **Body** (400, 17px, 1.6, max 46 to 52ch): ledes and section copy; 16px / 1.55 inside lists; 13px / 1.5 for captions under tables.
- **Label** (750, 11px, 0.12em, uppercase, wdth 78): the cobalt form headers on tables. The field label is a sibling at 12px, 0.14em, wdth 75, in soft ink; the form code is 11px, 0.14em, wdth 75 in faint ink.
- **Print** (Doto 800, 15px / 24px, tabular, 0.02em; 13px under 420px): every ledger and saldo line, the email field, the print head, the ticket time.
- **Queue number** (Doto 900, 64px): the ticket's number, the one print set large, because it is a different machine's output.

### Named Rules
**The One Print Size Rule.** Inside a ledger every printed line is 15px (13px under 420px). Rank comes from double-strike (900 weight plus a 0.6px shadow strike), reversal (ink ground, paper text), a heavier rule, or a stamp, never from a larger size.

**The Width Axis Rule.** Hierarchy in Archivo is set by weight and width together: wide and heavy for headings, narrow and tracked for labels. Don't add a second sans.

## Layout

A centered frame (max 1240px) inside a phone gutter of max(16px, safe-area), 24px from sm and 40px from lg. The first viewport is the open passbook: one spread of two paper pages meeting at a spine, split 1:1 from lg, with a 40px fold shadow on the right page's inner edge. Below lg the spread folds to one page, slip first, the ledger below a 2px dashed ruling-green fold.

Later sections are single sheets on the cloth, each split 5fr / 6fr from lg (heading and copy left, table or list right) with a 56px gap. Sheets pad 20px across on phones and 40px from sm, 40px down on phones and 56px from sm. Sections stack 56px apart on phones, 80px from sm. The closing slip sits on a sheet beside foil text set directly on the cloth.

Column rules are the only grid inside the ledger: 1px cobalt at 25% on the left of each column, dashed ruling-green row rules. On phones the BIG TRADE column drops and the stamp prints on its own row under the trade.

## Elevation & Depth

Depth is physical and shallow: paper lying on cloth. Each sheet carries a thin paper-edge line under it and a soft shadow cast onto the cloth; the spread casts a slightly deeper one. The queue ticket, the only object that lifts off the page, casts its own small shadow. There are no glows, no blur, and no layered cards inside a sheet.

### Shadow Vocabulary
- **Sheet** (`box-shadow: 0 1px 0 var(--paper-edge), 0 18px 40px -18px rgb(8 20 48 / 0.75)`): every single sheet on the cloth.
- **Spread** (`box-shadow: 0 2px 0 var(--paper-edge), 0 30px 60px -24px rgb(6 16 40 / 0.85)`): the open passbook in the first viewport.
- **Ticket** (`box-shadow: 0 10px 24px -12px rgb(19 44 92 / 0.55)`): the queue ticket lying on the page.
- **Button lip** (`box-shadow: 0 2px 0 var(--cloth-deep), 0 6px 14px -6px rgb(19 44 92 / 0.7)`): the primary button's key travel; it collapses to zero as the button presses down 2px.

### Named Rules
**The Paper-Thickness Rule.** The hard 1 to 2px line under a sheet is paper thickness, and the button's 2px lip is key travel that disappears on press. Neither is a decorative offset shadow; don't add hard offsets anywhere else.

## Shapes

Nearly square. Sheets and stamps round at 3px, the spread at 4px, the print head at 2px; the email field has no box at all, only a 2px dashed baseline. Ruling is the form language: dashed rules between rows, solid cobalt rules under table heads, a 2px ink rule where buyers turn to sellers. The ticket's top edge is perforated (a repeating 12px radial cutout in paper color). Stamps sit tilted at -4 degrees (the RECORDED stamp at +3) and their borders break through the `#stamp-ink` SVG filter: fine specks, edge wobble, and broad blotches where ink ran thin.

## Components

### Buttons
Tactile and stationery-plain: a cobalt key with foil lettering.
- **Shape:** gently squared (3px), 48px minimum height, 20px side padding.
- **Primary:** cloth background, foil text, Archivo 750 at 15px, wdth 92, 0.02em tracking.
- **Hover / Focus:** background lifts to a lighter cobalt; focus is the global 2px violet ring at 3px offset. Active presses down 2px and the lip collapses (150ms ease-out).
- **Disabled / Sending:** label changes to the sending copy, 80% opacity, progress cursor.

### Inputs / Fields
- **Style:** a line on a form, not a box: transparent ground, 2px dashed ink baseline, Doto print at 17px, violet caret, soft-ink placeholder.
- **Focus:** the baseline turns solid violet and the paper behind it brightens slightly (paper at 60%).
- **Error / Disabled:** invalid turns the baseline red and replaces the privacy line with a red message (14px); disabled drops to 60%.

### Navigation
Foil on cloth, top right: the language switch (Archivo 650, underlined in dim foil, full foil on hover). The sign-in link for people already let in is hidden for now.

### Sheet
The container for everything below the fold: security paper with the 96px guilloche tile, 3px corners, the sheet shadow, 40px by 56px padding from sm.

### Ledger (signature)
A Doto table on the right page. Cobalt form headers (TIME, PRICE, LOTS, BUYER, SELLER), 1px cobalt column rules, dashed rows, the Ribbon Fade on older lines, the newest line double-struck. A trade of Rp1 B or more reverses (ink ground, paper text), double-strikes and takes a BIG TRADE stamp with its value. Under the table, the print head: a reversed strip naming the replay's current trade time and position (96/318).

### Stamp
Violet rubber stamp: 2px violet border, Archivo 800 at 11px, wdth 80, 0.12em uppercase, tilted -4 degrees, inked through `#stamp-ink`. Used for RECORDED, BIG TRADE and NET BUYER: facts about the record, never calls to action.

### Queue Ticket (signature)
What the slip becomes after joining: a near-white thermal ticket (max 22rem) with a perforated top, a title and the time taken separated by a dashed rule, the queue number in 64px Doto (A-0127), and a one-line status. It replaces the form in place in both slips.

### Saldo Table
The ledger's balance page: broker, net lots, net value in print, buyers above a 2px ink rule and sellers below, the top buyer double-struck with a NET BUYER stamp.

## Do's and Don'ts

### Do:
- **Do** set every ledger entry in Doto at the one print size (15px, 13px under 420px) and rank lines with double-strike, reversal, rules or a stamp.
- **Do** put pre-printed form parts (headers, column rules) in cobalt and machine-printed entries in ribbon ink.
- **Do** fade older ledger lines toward the paper by at most 32% and keep the newest darkest.
- **Do** reserve green and red for prices, with red also allowed for a form error.
- **Do** lay content on security paper sheets over the cobalt cloth, with the sheet shadow and paper-edge line.
- **Do** keep motion to the printer's grammar (line print, carriage, stamp-down, ticket-out) and render a complete still frame with all of it off under reduced motion.

### Don't:
- **Don't** print a ledger line larger to make it important; double-strike or stamp it.
- **Don't** use violet for anything but stamps, focus, caret and selection.
- **Don't** add glows, gradients on type, or a dark screenshot hero; the passbook is paper and ink.
- **Don't** box the email field; it is a dashed line on the form.
- **Don't** add hard offset shadows beyond paper thickness and the button's key lip.
- **Don't** stamp calls to action; a stamp records a fact about a trade or the record.
