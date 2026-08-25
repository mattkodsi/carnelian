# Weekly Scheduler — design

**Date:** 2026-08-24
**App:** Carnelian (`index.html`, single static file + Supabase edge function)

## Goal

A weekly calendar view like Cornell's official Scheduler: pick a term, and that
term's courses lay out on a Mon–Fri grid by time-of-day as color-coded blocks
showing course code, section, location, and meeting time. Header shows
"N courses · X credits". Overlaps split side-by-side; conflicts are flagged.
iPhone-first.

## 1. Data model

One new column on `carnelian.enrollments`:

```sql
alter table carnelian.enrollments
  add column if not exists meetings jsonb not null default '[]'::jsonb;
```

`meetings` is an **array** of meeting blocks so a course can carry a lecture
*and* a discussion/lab:

```json
[
  {"component":"LEC","section":"001","days":["M","W","F"],"start":"09:05","end":"09:55","location":"Uris Hall 202"},
  {"component":"DIS","section":"205","days":["R"],"start":"14:30","end":"15:20","location":"White Hall 110"}
]
```

- `days`: Cornell letters — `M T W R F` (R = Thursday). `S`/`Su` (weekend) are
  stored if present but not placed on the M–F grid (listed as unscheduled).
- `start`/`end`: 24-hour `"HH:MM"`.
- `component`/`section`/`location`: display strings; `location` may be empty
  (future terms before room assignment, or async).

### Backend deploy (owner does this)

1. Run the SQL above.
2. Add `"meetings"` to `COLS.enrollments` in the deployed edge function, then
   redeploy. `load` already does `select *`, so it flows through automatically.

> **Note:** the repo copy of `COLS.enrollments` is missing `analog_of` and
> `in_as`, which the frontend already relies on — the deployed function is ahead
> of the repo. This change reconciles the repo copy (adds `analog_of`, `in_as`,
> `meetings`). The owner must ensure their *deployed* list includes `meetings`.

## 2. Getting meeting data in

### Roster auto-fill (primary path)

The course modal's existing "Search roster" is extended:

1. **Term first.** The Term field moves above Code in the modal. Roster search
   uses the selected term's roster, mapped from `config/rosters.json`
   (`descr` "Fall 2025" ↔ `slug` "FA25"; derived from the term name, validated
   against the config). Rosters exist back to FA14, covering all real terms.
2. Type code → "Search roster" → fills title/credits/tags (as today) **plus**
   pulls the class's sections.
3. **Section pickers = auto-filled dropdowns, no typing.** Cornell nests
   sections two ways, both handled:
   - *Multiple offerings* (e.g. PHIL 1110 SEM 101/102/103): one dropdown to pick
     the offering (enrollGroup).
   - *One offering, multi-option component* (e.g. PHIL 1100 LEC 001 + DIS
     201–206): the fixed lecture auto-includes; a dropdown picks the discussion.
   General rule: if `>1` enrollGroup, a dropdown selects it; within the selected
   enrollGroup, each component with `>1` section option gets its own dropdown;
   single-option components auto-include. Each option label shows time + room
   (e.g. "DIS 205 · F 12:20–1:10 · Rockefeller 231"). Selecting sets the
   `meetings` blocks. A sensible default (first option per component) is applied
   immediately on search.
4. Re-searching later refreshes times/rooms (e.g. rooms assigned after search).

### Manual editor (break-glass + override)

A collapsible "Meeting times" section (mirrors the existing "Map to requirements"
toggle). Each row: day toggles `M T W R F`, start/end (`<input type=time>`),
location, section label; add/remove rows. Auto-expands when meetings exist or
after a roster fill. Needed for Oxford study-abroad terms (not Cornell rosters),
transfers, pre-2014, async/online courses, or manual overrides.

## 3. Schedule tab

- **Placement:** replaces the Wishlist nav item. Wishlist becomes a compact
  button in the Planner banner that opens the saved courses as a modal sheet
  (no more full-width row).
- **Header:** term `<select>` + "N courses · X credits" summary + a "⚠ conflict"
  note when two of the term's courses overlap. Defaults to the current term,
  else the nearest term that has meeting data.
- **Grid:** thin time gutter + 5 columns (Mon–Fri). Vertical range = earliest
  start → latest end across the term (rounded to the hour; fallback 8am–6pm),
  with hour gridlines.
- **Blocks:** absolutely positioned by start/duration; an MWF lecture renders as
  three blocks. Content: course code (bold), section, time, location (location
  hides on very narrow columns). **Color per course** = deterministic hash of the
  code → curated ~10-hue palette with light+dark variants (soft fill, accent
  left border, readable ink), theme-aware. Tapping a block opens the course modal
  (`openCourse`).
- **Overlaps:** overlapping blocks in a day split that column side-by-side
  (interval-partition into sub-columns). Genuine conflicts also surface in the
  header note.
- **Unscheduled list:** below the grid, that term's courses with no M–F meeting
  (async/online/TBA/weekend/not-yet-entered) shown as chips (tap → modal), so
  nothing is hidden, with a nudge to add times.
- **Empty state:** term with no meeting data → prompt to add meeting times.

## 4. Mobile (iPhone-first)

Fit all 5 days on screen (thin ~26px gutter, compact blocks showing code + time;
location drops out on narrow columns) — matches Cornell's own mobile Scheduler.
Fallback if too cramped in practice: a day-focus switcher (tap M/T/W/R/F). Build
fit-5 first and judge from a real screenshot.

## 5. Out of scope (v1, YAGNI)

Drag-to-move blocks, .ics export, print view, multi-term overlay, weekend columns
(rare Cornell Sat/Sun meetings fall into the unscheduled list).

## Files touched

- `index.html` — scheduler CSS + palette, Schedule tab render, course-modal
  meeting editor + roster picker, roster-lookup rewrite (term→roster, sections),
  nav swap (Wishlist → Schedule), Wishlist-as-modal, save path writes `meetings`.
- `supabase/functions/carnelian/index.ts` — add `analog_of`, `in_as`, `meetings`
  to `COLS.enrollments` (repo reconciliation; owner redeploys).
