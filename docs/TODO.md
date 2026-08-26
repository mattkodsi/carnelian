# Carnelian — TODO / backlog

Non-urgent follow-ups, newest first.

## Assignments: richer deadline timing + schedule visualization

**Status:** open · planned next

Rework assignment deadline timing so a due moment can be expressed as more than a
single time. The user's example: a memo due by 8am the day of a Management
Communication class, but they want to *set* it as due midnight the night before,
since they'll never work on it that morning. So the "due" concept needs options —
sketch: **all-day · specific time · time window (start–end) · during class · a plain
deadline**. Decide how a single-moment deadline renders on the weekly Schedule grid
(a line? a small marker at the time? a top-strip chip already exists for all-day).

Hard constraint from the user: **do NOT complicate the app** — avoid rebuilding
Google Calendar. Keep the model as small as it can be while covering these cases.
Design this (brainstorm) before building. Touches the assignment editor + `asgWeek`
/ schedule rendering in `index.html`.

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
