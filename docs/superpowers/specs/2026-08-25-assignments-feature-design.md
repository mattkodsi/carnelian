# Assignments feature — design

_Carnelian (Cornell degree/schedule tracker). Date: 2026-08-25._

## Goal

Let the user maintain per-course assignments/deadlines for the semester in one
place, entered through **structured fields that compose a standardized title**,
which then **auto-populate the Schedule week view**. Canvas is used only as a
one-time aggregation source to pre-fill items into a review queue — not a live
integration (student Canvas API tokens require a faculty sponsor, so no
server-side sync is possible).

## Decisions (all confirmed with user)

1. **Entry point:** Planner tab → tap a course → that course's assignment list (add/edit/delete).
2. **Schedule rendering — both, by type:** `exam`/`quiz` render as **timed blocks** in the grid at their start time; everything else renders as **all-day chips** on the due date in the top overlay strip (alongside academic dates).
3. **Storage:** server-side, in the Supabase `carnelian` schema (new `assignments` table + edge-function CRUD), loaded with the rest of the app on sign-in. Chosen over localStorage for cross-device sync and to enable a future Google "Deadlines" calendar layer.
4. **Pre-load via review queue:** the ~39 scraped Canvas items start as `pending`; the user approves/rejects each before it hits the schedule. Only `active` items render.
5. **Naming — composed + override:** the title is auto-composed from structured fields with a live preview; a hand-edit override is available for exceptions.
6. **Done state (v1):** each assignment can be checked off from its Planner list; done items render dimmed + struck through on the Schedule.

## Naming system (the core of standardization)

The user does **not** type a full title. They fill structured fields and the app
composes a canonical label deterministically.

Fields:

- **Kind** (required, fixed dropdown): `Exam · Quiz · Homework · Assignment · Problem Set · Paper · Presentation · Project · Reading · Draft · Survey · Other`. Drives both the label lead word and the render type (Exam/Quiz → timed block; all others → chip).
- **Series** (optional, autocompleted from values already used in that course): course-specific streams, e.g. "Writing Case", "Speaking Case", "Midterm Exam". Suggestions prevent retyping variants.
- **Number** (optional integer).
- **Descriptor** (optional; auto Title-Cased + trimmed on save).
- **Override title** (optional): when set, used verbatim (lightly trimmed) instead of the composed label.

Composition rule:

```
title = override_title?.trim()
     || `${series?.trim() || KIND_LABEL[kind]}` +
        (number != null ? ` ${number}` : ``) +
        (descriptor?.trim() ? `: ${titleCase(descriptor.trim())}` : ``)
```

Examples:

| Fields | Label |
|---|---|
| Kind=Quiz, Number=2 | `Quiz 2` |
| Series="Midterm Exam", Kind=Exam | `Midterm Exam` |
| Kind=Assignment, Series="Writing Case", Number=3, Descriptor="Leasing Memo" | `Writing Case 3: Leasing Memo` |
| Kind=Homework, Descriptor="Cover Letter Draft" | `Homework: Cover Letter Draft` |

Standardization guarantees:

- **Course code is never stored in the title.** It is a separate field. Shown bare on the course's own list; prefixed uniformly as `CODE · Label` in any out-of-context surface (combined views, the future Google calendar).
- **Dates are never in the title.** They live in the date/time fields.
- A **live preview** shows the composed title while editing.
- The composer is mirrored client-side (for preview/render) and server-side (denormalized `title` stored for convenience / future GCal summaries).

## Data model

New table `carnelian.assignments`:

| Column | Type | Notes |
|---|---|---|
| `id` | uuid pk | `gen_random_uuid()` |
| `enrollment_id` | fk → course enrollment | the course this belongs to |
| `kind` | text | controlled vocabulary above |
| `series` | text null | |
| `number` | int null | |
| `descriptor` | text null | |
| `override_title` | text null | |
| `title` | text | denormalized composed label (recomputed on write) |
| `due_date` | date | |
| `due_time` | time null | required for timed kinds; else optional |
| `duration_min` | int null | for timed blocks (e.g. exam 75) |
| `status` | text | `pending` \| `active` \| `done` |
| `source` | text | `canvas` \| `manual` |
| `created_at` / `updated_at` | timestamptz | |

Rejecting a pending item deletes the row. `done` is a **v1** checkable state:
the user can check an item off from its Planner list. Done items render on the
Schedule **dimmed + struck through** (not hidden), so the week stays honest while
showing progress; they sort below open items in the Planner list.

## Backend

- Edge-function actions: `assignment_save` (insert/update, recomputes `title`), `assignment_delete`, and bulk `assignment_review` (approve/reject pending). `api("load")` returns a new `assignments` array in the DB payload.
- Follows existing edge-function conventions (session-token auth, postgres.js, inline-deploy). Migration file adds the table.

## Planner UI

- Each course row in the Planner gains a tap target → opens that course's **assignment list** (sorted by date), with add/edit/delete.
- Add/edit form = the structured fields + live title preview + override toggle + date/time (+ duration for timed kinds).
- A course with `pending` items shows a small **"N to review"** badge; opening the list surfaces the review actions (approve/reject per item).

## Schedule rendering

- Reads `active` + `done` assignments for the visible week from `DB.assignments` (`pending` never renders; `done` renders dimmed + struck through).
- **Timed (`exam`/`quiz`):** block in the grid at `due_time` for `duration_min`, styled distinctly from class meetings (e.g. outlined/marked "EXAM"/"QUIZ"), in the course's color. Falls back to a chip if no time.
- **Chips (all other kinds):** all-day chip on `due_date` in the top overlay strip, visually distinct from academic-date chips (own accent), capped with "+N more" like the academic overlay, tap → detail sheet.
- Baked share image includes them consistently (same as academic overlay handling).

## Canvas scrape importer (one-time pre-load)

- Source data: `scratchpad/canvas_fall2026_aggregated.json` (REAL 6101 assessments from the Class Schedule PDF + REAL 6640's 30 Canvas assignments).
- Importer **decomposes** each scraped title into the structured fields (e.g. "Writing Case 1: Cold Email" → Series/Number/Descriptor; "Quiz 2" → Kind/Number; "Homework: X" → Kind/Descriptor); oddballs use `override_title`.
- Maps each item to the user's Carnelian enrollment by **course code**; inserts as `status=pending, source=canvas`.
- For 6101's "end of class" quizzes, seed `due_time` at the course meeting time and flag for the user to adjust in review.

## Out of scope (future)

- A "Carnelian – Deadlines" **Google Calendar layer** (server-side sync of `active` assignments), mirroring the existing academic-layer pattern. Deferred.
- Courses with no Canvas site (REAL 6901 / 5950 / 6595 and any others) are entered manually — no pre-load available.

## Open items to confirm during build

- Exact seed times/durations for 6101 quizzes (default: course meeting slot; user adjusts).
- Visual treatment distinguishing assignment chips from academic chips, and exam/quiz blocks from class blocks (kept legible in the baked share image and both themes).
