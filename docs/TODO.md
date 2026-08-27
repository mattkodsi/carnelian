# Carnelian — TODO / backlog

Non-urgent follow-ups, newest first.

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
