# Carnelian — TODO / backlog

Non-urgent follow-ups, newest first.

## Assignments agenda page (Academic tab)

**Status:** shipped 2026-08-30

The Academic tab is now a rolling, color-coded **Assignments agenda** instead of the
Cornell calendar: this-term-forward, overdue pinned on top, day sections (empty days
skipped), rows sorted by course color within each day, each row carrying the course
color as a left bar + colored code. Canvas-scraped items appear inline with
**Accept/Reject/Edit**; active items get a done-checkbox; done items dim + strike in
place. A **Sync** button reuses the `carnelian-canvas` path. The Cornell academic
calendar moved to a **button in the Schedule header** (opens a sheet reusing the
existing scrape/cache); the Schedule's day-top **Due chips** are now colored by course
(3px left bar, was a dot) — live strip + share PNG. Nav item relabeled Academic →
Assignments. Pure `index.html` change; color map matches `renderSchedule` exactly. Spec
`docs/superpowers/specs/2026-08-30-assignments-agenda-design.md`, plan
`docs/superpowers/plans/2026-08-30-assignments-agenda.md`. See `renderAssignments`/
`agFocusTerm`/`agColorMap`/`wireAgenda`/`openAcalSheet` in `index.html`.

## Canvas .ics deadline auto-sync

**Status:** shipped 2026-08-27

Nightly server-side sync of the user's tokenized Canvas calendar feed into the
assignment review queue — no Chrome, no login. Built as an isolated edge function
`carnelian-canvas` (kept separate from the main gateway) + `pg_cron`/`pg_net` job
+ a Planner "Sync Canvas" button. Parser: `supabase/functions/carnelian-canvas/
ical.ts` (Node-tested). Only Canvas *assignments* sync (calendar events like office
hours are filtered); cross-listed tags map to the enrolled course; idempotent via
`assignments.ext_uid`; de-dupes against prior scrapes; never overwrites edits or
auto-deletes. Spec/plan under `docs/superpowers/`.

Possible follow-ups (low priority): the "Sync Canvas" toast surfaces raw server
strings ("no feed configured") — fine as a fallback but could be friendlier; and
the 4 genuinely-unmapped feed items (COCR 100, a sustainability program) are
correctly skipped — no action unless the user starts tracking those.

## Assignments: richer deadline timing + schedule visualization

**Status:** shipped 2026-08-26

Resolved with the principle **spans on the grid, points in a Due strip**. Deadlines
never go on the time grid (points don't belong on a span grid — at-class collides,
late-night falls off, stacking overcrowds). Instead every deadline is a chip in the
per-day Due strip: course-color dot · title · time (two lines on narrow columns),
sorted by time, "+N more" → day sheet. Model added `target_on`/`target_time` (a
work-by target, shown on the schedule when set; real `due_on`/`due_time` stays in the
editor). Editor gained: optional time for any kind, a "Due at class time" fill, and a
collapsed "Work by an earlier target" toggle. Schedule header compacted (dropped the
"Schedule" H1; term+tools / week-nav+count) to give the grid room. See `asgWhenDate`/
`asgWhenTime`/`asgWeek`/`openAsgEditor` in `index.html`.

## Course editor: link discussion/lab sections to their parent lecture

**Status:** open · low priority (rare; does not affect single-section grad courses)

**What:** When the section picker gathers a course's sections, it currently lists
each component independently (all lectures, all discussions, all labs). For most
courses that's correct — either there's one lecture with several discussions you
may freely choose among, or several parallel sections of a single component
(e.g. multiple lab times), which the picker now handles well.

The gap is the rarer case where Cornell publishes **multiple `enrollGroups`, each
containing more than one component type** — i.e. two lecture offerings that each
have their *own* linked discussion(s). There the components are meant to be taken
together, so picking "LEC 002" should restrict the discussion options to LEC 002's
group. Today you could pick LEC 001 from one group and a discussion from another,
which isn't a valid enrollment combination (though for a personal tracker you'd
just pick your real sections yourself).

**Is it real?** Yes, but uncommon. A full FA26 scan turned up only a handful, almost
all of them *single-component* multi-group courses (multiple labs/practicums), which
the current flat handling gets right. The genuine multi-component-multi-group case
was essentially just large intro courses like **ECON 3030** (2 enrollGroups, each
LEC + DIS). None of the Baker/HADM/REAL grad courses hit this — e.g. REAL 5370 is
two practicum (PRS) groups, a single component, which is handled correctly.

**Fix sketch:** track each section's `enrollGroup` index; treat the primary component
(LEC/SEM) as selecting the group; when it changes, re-scope and re-default the other
components' pickers to sections within that same group. See `buildSectionGroups` /
`applySections` / `renderMeetSel` in `index.html`.

**Why deferred:** doesn't affect the user's program, and the flat picker is still
usable in the rare case (you just pick your actual sections). Revisit if a real
course makes it annoying.
