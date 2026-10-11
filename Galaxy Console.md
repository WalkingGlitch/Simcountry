# Galaxy Console — Usage Guide

**Simcountry Galaxy Console** (version 3.0) is a CentauDos viewer and console. It opens in its own window, builds a local shuttle register and event log, and lets you browse shuttles, stations, markets, docks, and flights without constantly switching game pages. Writes (rename, flights, cargo, docking, trade, transports) are **off by default** and each one is confirmed against a live form the game itself produced.

This guide covers the everyday workflow. For install links see the main [README](README.md).

## Opening the console

1. Install the script from the raw URL in the main README (or paste the file into Tampermonkey).
2. Log in to Simcountry and open the main portal.
3. On the **Worlds & Space Travel** gadget a small bar appears with two buttons:
   - **Galaxy Console** — opens the full viewer in a new window.
   - **Game galaxy** — opens the game's own galaxy window.
4. You can also open the console directly by visiting the galaxy root URL with the hash `#galaxyplus`.

The original game pages are left alone except for the added launcher button. The console window is a separate view that reads the same data the game uses.

## Main window layout

The top bar shows:

- Tabs: **Shuttles**, **Stations**, **Space Centers**, **Markets**, **Trends**, **Docking**, **Transport**, **Events**, **Debug**, **Settings**
- Session status (signed in / out)
- Map update status and counts of active shuttles
- Pending / failed / retried request counts

Below that is the filter bar and the main table (or panel) for the current tab. On the right of the Shuttles tab you see the map fragment of the currently selected shuttle's area.

## Shuttles tab

This is the primary view. The table is virtualized so hundreds of shuttles stay responsive.

**Filters**

- Text box: matches name, owner, place, or ID.
- Owner dropdown: all owners, or only yours (marked "(me)").
- Status and location dropdowns.
- Checkboxes for "include stale" and "retired".
- Column mode selector and a "reset widths" button.

**Columns**

Name, Owner, Location, Destination, Cargo, Missions, Since (tu), Arrival (tu), Status, Seen. You can sort by clicking headers. Column widths can be adjusted and are remembered.

**Selecting a shuttle**

Click a row. The right-hand pane shows details for that shuttle (logbook, cargo, flight plan when available) and the map centers on its location when the map is visible.

**Bulk rename**

When writes are enabled (see Settings), a **Bulk rename…** link appears. It only affects shuttles you own. Each rename is still gated by the rename family switch and the ownership check.

**Status line**

Shows how many shuttles match the current filters, how many are idle / in flight, and how many need offload or are stale.

## Stations, Space Centers, Markets, Docking

These tabs show the corresponding game lists (stations, space centers, markets, free docks). Sorting and text filters work the same way as the shuttle list. Clicking a row loads more detail (market offers, docking list, etc.) into the side pane when available.

The console refreshes these lists on a slower cadence than active shuttles so it does not hammer the game.

## Transport tab

Used to stage and submit transport requests.

- Origins, targets, and products are loaded from the game's own picker endpoints.
- You build a request in the form; nothing is sent until you explicitly confirm.
- The console captures the live form the game would have posted, so the fields and method match what the game itself uses.
- A queue of staged requests can be reviewed before any write.
- Cancel of an existing transport is also a gated write (two-step confirmation, same as the game's red X).

**Writes stay off until you turn them on in Settings and confirm each action.**

## Events tab

Shows the accumulated event log for shuttles (location changes, status changes, cargo changes, etc.). Newest events are kept in memory; the full history lives in IndexedDB.

You can export the events (and the shuttle register) as CSV from the Settings or Debug areas, or import a previous CSV to restore a register.

## Trends tab

Summarizes activity over time (flights, cargo movements, station visits) based on the events the console has already recorded. It does not invent data; it only charts what has been observed since the register started.

## Debug tab

Internal request log and script log (ring buffer). Useful when something looks wrong. You can filter by channel (net / script) and level. The ring is large by default; it does not leave your browser.

## Settings tab

All persistent preferences live here. Important ones:

- **Writes enabled** — master switch. Off by default.
- Per-family switches: **writeRename**, **writeFlights**, **writeCargo**, **writeDocking**, **writeTrade**. Each must be on in addition to the master switch.
- **Dry run** — log what would be sent without actually posting.
- **Form capture** — record the live forms the game produces (used to validate writes).
- **Seconds per tu** — used for arrival-time estimates.
- **Notifications** — arrivals (yours only or all), desktop notifications, sound.
- **Auto details** — whether to fetch shuttle detail pages in the background.
- **Keep-alive** — how often to probe the session while the console is open.
- **Column modes** and layout memory.

Settings are stored in the browser (localStorage / IndexedDB). They do not leave your machine.

## Map viewer

The console can also render the game's country / world / continent / region map fragments as a normal page. When you open a map link that uses the `#gxc-map=` hash, scripts and inline handlers are stripped and navigation stays inside the viewer. This is read-only.

## Data storage

- Shuttle register and event log are kept in **IndexedDB** (per browser profile).
- CSV export/import lets you back up or move the register.
- Debug and request rings are memory-only and are discarded when you close the window.
- Nothing is sent to any third-party server. All requests go to the same Simcountry hosts the game itself uses.

## Safety notes

- Writes are off by default. Even when you turn a family on, each action is checked against a captured live form and an ownership test before it is posted.
- The console never invents game endpoints. It only calls the read methods the game already uses, plus the specific write methods that have been allow-listed and gated.
- A game update can change page structure or form fields. If a write is refused, the console will say why (form mismatch, ownership, family switch off, etc.).
- You can run the console while the normal game galaxy window is open; they share the same session cookie.

## Tips

- Leave the console open in the background if you want continuous shuttle tracking. Active ships refresh about every 20 seconds; idle ships every 10 minutes.
- Use the owner filter set to "(me)" plus the "need offload" indicator to find shuttles that need attention.
- Export the CSV occasionally if you care about the long-term event history.
- If the launcher button disappears after a page refresh, reload the portal; the script re-injects it.

For the raw install URL and the rest of the toolkit see the main [README](README.md).
