# Assignments agenda page — design

**Date:** 2026-08-30
**Status:** approved (mockup + layout confirmed)

## Goal

Turn the **Academic tab** into a single, immaculate **Assignments agenda** — a rolling,
date-ordered list of every assignment this term from today forward, color-coded by course,
where Canvas-scraped items can be accepted or rejected inline. It should be *the* place to
see what's due and get it under control. The Cornell academic calendar (currently the first
thing on the Academic tab) moves out to a button on the Schedule, where the day-top academic
chips already live.

Three parts, smallest first:

1. **Color the Schedule Due-strip chips by course** (was: tiny dot only).
2. **Assignments agenda** replaces the Academic tab's calendar content.
3. **Academic calendar → a button in the Schedule header** (opens the full registrar list in a sheet).

Non-goals: no new data model, no server changes, no new assignment fields. This is a client
render + wiring change over the existing `DB.assignments` / `carnelian.assignments` data.

---

## Part 1 — Color the Due-strip chips

**Where:** `renderSchedule()` chip builder (`index.html:1747`) and `.adchip.asg` CSS (`:417–422`);
mirror in the share PNG (`buildSchedCanvas`, `:2868`).

**Now:** each deadline chip in the day-top Due strip is `title / time` with a 6px course-color
**dot** to the left.

**Change:** drop the dot; carry the course color as a **3px left accent bar** on the whole chip
(`border-left:3px solid <course color>`), matching the agenda rows. Title + time layout unchanged;
`.done` opacity/strike unchanged. The course color already flows in as `it.r.color`, so this is a
markup/CSS tweak — set the border color inline, remove the `.asg-dot` span, adjust `.adchip.asg`
padding so the text sits right against the bar.

**Share PNG:** replace the drawn dot with a short vertical color bar at the chip's left edge, same
course color, so the exported image matches the live strip.

---

## Part 2 — Assignments agenda (Academic tab)

Replaces the body currently produced by `renderAcademic()` (`:1903`). Routing key stays `academic`
(`data-nav="academic"`, panel `#academic`); the nav label changes **"Academic" → "Assignments"**
(`:643`), icon to a checklist/list glyph. The render function is renamed `renderAssignments()` and
its one call site updated.

### Scope + placement

- **This term, from today forward.** Include assignments whose enrollment is in a *current* term
  (`term.ends_on` null or `>= today`) and not `wishlist` — same scoping the sync uses server-side.
- **Placement date/time** = `asgWhenDate(a)` / `asgWhenTime(a)` (the work-by target if set, else the
  real deadline) — identical to the Schedule strip, so the two views never disagree.
- **Overdue** = in scope, placement date `< today`, **not done** — pinned in a section at the very top.
- **Upcoming** = placement date `>= today`, grouped by day.
- **Done** items show **dimmed + struck in their day section** (future days only; a done item dated
  before today simply drops off — done is done). Overdue never includes done items.

### Layout (top → bottom)

- **Header:** `Assignments` title · **Sync** button · one-line count
  `"<N> from Canvas to review · <M> upcoming"` (N = pending Canvas in scope; M = active upcoming).
  Sync runs `canvasSyncNow()` then re-renders the agenda + refreshes the count. Reuses the existing
  `CANVAS` client state and toast.
- **Overdue** (only if any): danger-tinted section header (`⚠ Overdue`), then rows.
- **Day sections** from today forward; **empty days are skipped entirely**. Section header =
  relative label + date: `Today · Fri, Aug 28`, `Mon · Sep 1`. "Today" (and "Tomorrow") emphasized;
  the date muted.
- Within a day, rows sort **by course color index** (`SCHED_CIDX` order) then by time, so same-course
  items cluster and the day reads by color.

### Row anatomy

Every row carries the course color three ways: a **3px left accent bar**, the **course code** in that
color, then **title** and **time**. Three states:

- **Pending (Canvas)** — subtle accent-tint background + **Accept** / **Reject** (+ **Edit**) buttons,
  mirroring the Planner review row (`renderAsgList` `prow`, `:1537`). Accept → `approveAsg` (status→active),
  Reject → `rejectAsg` (delete). Meta line notes `· from Canvas`.
- **Active** (not done) — round **done-checkbox** on the right → `toggleAsgDone`. Tapping the row body
  opens `openAsgEditor(eid, a)`.
- **Done** — dimmed, title struck, checkbox filled; tap checkbox to un-complete.

### Re-render wiring

`approveAsg` / `rejectAsg` / `toggleAsgDone` currently re-render `renderAsgList` (+ Planner). Extend
them to also re-render the agenda when it's the current view: after their mutation, `if(CUR==='academic') renderAssignments()`.
No behavior change to the Planner path.

### Empty state

If nothing is in scope: a plain message — *"No assignments this term. Add them per course in the
Planner, or use Sync to pull from Canvas."* (no marketing tone).

### Data

All client-side over `DB.assignments` + `DB.enrollments` + `DB.terms`. Helpers reused as-is:
`courseColor(en)`, `codeLabel(en)`, `asgTitle`, `asgWhenDate`/`asgWhenTime`, `asgTimeShort`,
`fmtAsgDate`, `asgById`, `SCHED_CIDX`, `SCHED_COLORS`.

---

## Part 3 — Academic calendar → Schedule button

The Cornell registrar calendar leaves the Academic tab and becomes a **button in the Schedule header
tools** (`tools`, `:1766`) — a calendar-icon button next to Share / Google-Calendar. It opens a sheet
(`#acalSheet`) whose body reuses the existing `paintAcademic` month/row markup and a Refresh action;
`openAcalSheet()` calls `loadAcademic()` (cache-first, same as today). The inline day-top academic
chips and the `openAcadDay` day-detail sheet on the Schedule are unchanged.

The old `renderAcademic()` markup (phead + `#acal-body` + refresh wiring) moves into the sheet
template; `paintAcademic` / `loadAcademic` are otherwise untouched, so the scrape, caching, and
"now/next" pills all keep working — they just render inside the sheet instead of the tab.

---

## Risks / notes

- **Placement vs. real deadline:** the agenda intentionally shows the work-by *target* when one is
  set (consistent with the Schedule). The real deadline still lives in the editor. Accept this;
  don't show both on the row.
- **Term boundary:** "current term" uses `ends_on >= today`; during the gap between terms this yields
  the upcoming term, which is the desired behavior (you see what's coming).
- **Isolation:** pure `index.html` change. No edge-function, DB, or cron changes. The Canvas Sync
  button reuses the already-deployed `carnelian-canvas` path.
