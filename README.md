# Simcountry QoL Scripts

Browser userscripts that take the busywork out of [Simcountry](https://www.simcountry.com/) — the long-running browser MMO where you run countries, enterprises, trade, and wars across several persistent worlds.

This repo is a small toolkit for people who already play. It does not replace the game. It just makes a few of the most tedious pages easier to live with.

[![Unlicense](https://img.shields.io/badge/license-Unlicense-blue.svg)](LICENSE)
[![Userscripts](https://img.shields.io/badge/requires-Tampermonkey-black.svg)](https://www.tampermonkey.net/)
[![Game](https://img.shields.io/badge/game-Simcountry-0b5cab.svg)](https://www.simcountry.com/)

| Script | Version | What it does |
| --- | --- | --- |
| [Loan Offers.js](Loan%20Offers.js) | 1.5.0 | Sort, filter, highlight, total, and batch-submit loan offers |
| [Order Strategies](Order%20Strategies) | 1.4.0 | Select, filter, preset, and snapshot stock-order strategies |
| [Portal.js](#portaljs-not-checked-in-yet) | — | Custom portal sort order + draggable ticker *(screenshot is here; script file is not)* |
| [War Casualty Bookmarklet](3rd%20Party/War%20Casualty%20Bookmarklet.txt) | 3rd party | Summarize war losses from a battle report page |

> Unofficial. Not affiliated with Simcountry or its operators. Use at your own risk, and stay inside the game's rules.

---

## Install

1. Install [Tampermonkey](https://www.tampermonkey.net/) for your browser.
2. Open a script file from this repo (or the raw URL).
3. Tampermonkey should offer **Install**. If it does not, create a new script and paste the file in.
4. Visit the matching Simcountry page while logged in. The extra UI appears on that page only.

Raw files:

- `https://github.com/WalkingGlitch/Simcountry/raw/main/Loan%20Offers.js`
- `https://github.com/WalkingGlitch/Simcountry/raw/main/Order%20Strategies`

Preferences are stored in Tampermonkey / `localStorage`. They stay on your machine.

---

## Loan Offers Toolkit

**File:** [`Loan Offers.js`](Loan%20Offers.js)  
**Author:** TheWalkingGlitch  
**Runs on:** country and enterprise loan-offer pages (`loanmyoff`, `eloanmyoff`, `cloanmyoff`, and close cousins)

The stock loan page is a form plus a flat list. This script keeps the native submit path and layers a small toolkit on top of it.

![Overhauled loan offers page with sorting, highlighting, and repeat submit](readmescreenshots/LoanOffersjs%20Example%20Screenshot.png)

### Features

- **Click-to-sort** the Offered Loans table by amount, period, or interest
- **Filter** the list as you type
- **Highlight** open offers above a threshold (default `1T`, color `#b8860b`, both editable)
- **Totals** for what is currently visible
- **Repeat submit** — post the same offer 1–50 times, with a short delay and a cancelable progress banner
- Remembers last amount, period, and repeat count
- Copy visible rows to the clipboard as text / CSV
- Sticky table headers so the columns do not vanish when you scroll
- Understands compact Simcountry numbers (`K` / `M` / `B` / `T` / `Q`)

Interest rates stay world-controlled. The script only fills amount, period, and how many identical offers to send.

---

## Order Strategy Toolbox

**File:** [`Order Strategies`](Order%20Strategies) *(no `.js` extension; Tampermonkey still accepts it)*  
**Author:** TheWalkingGlitch  
**Runs on:** Country → Trade → **Order Strategies** (`form name="fSOS"`)

Stock order strategies are a long grid of products. The toolbox is a floating panel on that page. Selection is a checkbox to the left of each industry icon — sorting the list does not change what is checked.

### Features

- Checkbox-select products, then apply values only to the checked set
- Search, category chips, and field filters (quality, low-water, order qty, OS mode)
- Reorder the live list without touching the site's save button
- Bulk fill **low-water**, **order quantity**, and **quality** (clamped to 120–330)
- Quality offset (`+` / `−`) for nudging a selection
- Modes: auto, months, units, or off — auto falls back when a product has no months strategy
- Presets:
  - Economy `3 / 14 @ 120`
  - Stockpile `8 / 24 @ 160`
  - Military `6 / 18` at quality cap
  - Civilian `3 / 14 @ 120`
- Named **revisions**: save the current page (or only checked rows), restore later
- Restore matches by product id first, then name + category, then unique name. New products on the page are left alone; missing saved ids are skipped.
- Draggable, collapsible panel

Nothing is sent until you hit the site's own save button.

---

## Portal.js (not checked in yet)

The README screenshot and the original description are in this repo. The script file itself is not on `main` right now.

Intended behavior, from the existing notes:

- Custom sort order for countries and enterprises on the portal page
- Click-and-drag the ticker strip on pages that have one

![Custom sort order UI on the main portal page](readmescreenshots/Portaljs%20Example%20Screenshot.png)

If you have a local copy, drop it in the repo root as `Portal.js` and this section can grow a real install link.

---

## War Casualty Bookmarklet (3rd party)

**File:** [`3rd Party/War Casualty Bookmarklet.txt`](3rd%20Party/War%20Casualty%20Bookmarklet.txt)  
**Author:** hymy — published here with permission from the Simcountry Discord

A bookmarklet, not a Tampermonkey script. It reads the attacker / defender report blocks on a war page, totals equipment losses plus soldiers killed and wounded, and opens a compact comparison table in a new window.

### Install

1. Open the text file and copy the single `javascript:...` line.
2. Create a bookmark in your browser and paste that line as the URL.
3. Open a Simcountry war / battle report page and click the bookmark.

---

## Repository layout

```
Simcountry/
├── Loan Offers.js
├── Order Strategies
├── LICENSE
├── README.md
├── readmescreenshots/
│   ├── LoanOffersjs Example Screenshot.png
│   └── Portaljs Example Screenshot.png
└── 3rd Party/
    └── War Casualty Bookmarklet.txt
```

---

## Notes and limits

- These scripts scrape and click the live site. A game update can break them overnight.
- They are client-side only. They do not talk to a third-party server.
- Batch loan submits reload the offer page once per offer, with a delay. Do not walk away from a 50-offer job if you care about the result.
- Order-strategy revisions live in userscript storage. Export nothing you cannot rebuild.
- Unofficial tools can sit in a grey area of a game's rules. If Simcountry says no, stop.

---

## License

[The Unlicense](LICENSE) — public domain.

Copy, modify, ship, or ignore with or without credit. The software is provided **as is**, without warranty of any kind. It may work. It may not. It will not reimburse you for a bad loan book.

---

## Contributing

Issues and PRs are welcome, especially:

- `Portal.js` actually landing in the tree
- Game-page selectors that drifted after a Simcountry update
- Safer defaults for repeat-submit and quality clamps

Keep changes scoped to one page family at a time. The game's markup is old and specific; broad refactors tend to miss a country vs enterprise variant.
