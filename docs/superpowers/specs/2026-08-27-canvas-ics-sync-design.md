# Canvas `.ics` → Carnelian deadline sync — design

**Date:** 2026-08-27
**Status:** approved (design)

## Goal

Auto-populate Carnelian's assignment/deadline layer from the user's Canvas
calendar **without** the manual logged-in-Chrome scrape. Canvas exposes a
tokenized personal iCalendar feed (`canvas.cornell.edu/feeds/calendars/user_<token>.ics`)
that needs **no login** — the token in the URL is the auth — so a server job can
fetch it on a schedule and keep deadlines current through the term.

New Canvas items land in the **existing review queue** (`status='pending'`) for a
quick approve/reject/rename pass; they never appear on the schedule unmapped or
unapproved.

## Non-goals

- Not a replacement for everything: only *dated* Canvas items appear in the feed.
  Deadlines that live only in a syllabus PDF (e.g. REAL 6101's schedule) stay
  manual.
- No rich structure from the feed (points, modules, Kind/Series/Number). Synced
  items are coarse (title + due date/time) and are refined in review.
- No auto-delete of items, no overwriting user edits (see Update policy).

## Architecture / flow

```
pg_cron (nightly)
  → pg_net.http_post → carnelian edge fn  {action:"canvas_sync", cron_secret}
App "Sync now" button
  → POST carnelian edge fn                {action:"canvas_sync", token}
                              │
                              ▼
   fetch canvas_config.feed_url (server-side secret)
   fetch the .ics over HTTPS (no auth beyond the URL token)
   parse VEVENTs  → {uid, summary, dtstart, dtend, url, description}
   map each to an enrollment (current/upcoming terms)
   guess kind from keywords
   reconcile against existing assignments (de-dupe & keep)
   upsert into carnelian.assignments as status='pending', source='canvas'
   record last_sync_at + last_result on canvas_config
```

Reuses the edge function's existing auth, Postgres pool, CORS, and the
established "server fetches an external URL + regex-parses it" pattern already
used for the Cornell registrar academic calendar (`fetchAcademic` /
`parseAcademicCalendar`).

## Data model (one migration)

```sql
-- external id so re-syncs update-in-place instead of duplicating
alter table carnelian.assignments
  add column if not exists ext_uid text;
create unique index if not exists assignments_ext_uid_uidx
  on carnelian.assignments (ext_uid) where ext_uid is not null;

-- locked config row for the feed (mirrors gcal_config)
create table if not exists carnelian.canvas_config (
  id            int primary key default 1,
  feed_url      text,
  last_sync_at  timestamptz,
  last_result   jsonb,
  updated_at    timestamptz default now()
);
insert into carnelian.canvas_config (id) values (1) on conflict (id) do nothing;
```

`ext_uid` is written **only by the server sync**, never via the client's generic
`upsert` — it is deliberately kept out of `COLS.assignments`.

## Edge function: `canvas_sync` action

Authorization: accept **either** a valid session token (app "Sync now") **or** a
`cron_secret` equal to the `CANVAS_CRON_SECRET` env var (scheduled call). Runs
before the normal `authed()` gate for the token path.

Steps:
1. Load `canvas_config`; if no `feed_url`, return `{ok:false, error:"no feed configured"}`.
2. `fetch(feed_url)` with a 10s AbortController timeout and a UA header (same as
   the registrar fetch). On non-200, return the status as an error.
3. Parse the iCal text (see below) → array of raw events.
4. Load active enrollments (`status <> 'wishlist'`, term ends_on null or ≥ today)
   with `id, code, term_id`.
5. Load existing assignments for those enrollments (`id, enrollment_id, name,
   due_on, ext_uid, status, source`) for reconciliation.
6. For each parsed event within scope (due ≥ today−7d): map course, guess kind,
   reconcile, and collect an upsert.
7. Apply upserts; write `last_sync_at = now()`, `last_result = {added, updated,
   adopted, unmapped, total}`.
8. Return the counts.

## iCal parsing

Pure string/regex, no dependency (matches the codebase style):

- Normalize CRLF, then **unfold** continuation lines (a line beginning with a
  space or tab continues the previous line).
- Split on `BEGIN:VEVENT` … `END:VEVENT`.
- Per event pull properties, tolerating parameters before the `:` —
  `UID`, `SUMMARY`, `DTSTART`, `DTEND`, `URL`, `DESCRIPTION`.
- Unescape iCal text (`\,` `\;` `\n` `\\`).
- **Datetime → ET.** Three DTSTART forms:
  - `DTSTART:YYYYMMDDTHHMMSSZ` (UTC) → convert to America/New_York → `due_on` +
    `due_time`. Canvas due dates are UTC; `T035959Z` = 11:59 pm ET.
  - `DTSTART;VALUE=DATE:YYYYMMDD` (all-day) → `due_on`, `due_time = null`.
  - `DTSTART;TZID=America/New_York:YYYYMMDDTHHMMSS` → take wall-clock as-is.
  - ET conversion uses a fixed EST/EDT offset derived from the date (US DST
    rules) — no external tz library; verified against a known Aug (EDT, −4) and
    Jan (EST, −5) sample during build.

## Course mapping + kind inference

- **Course hint:** Canvas tags each event's course in the `SUMMARY` (suffix like
  `[FA26-REAL-6640-001]` or `(REAL 6640)`) and/or `DESCRIPTION`. Extract digits+
  subject, normalize (drop term prefix `FA26`/`SP27`, collapse separators) to a
  canonical `REAL6640`, and match against normalized `enrollments.code` for the
  in-scope terms.
- **No confident match** → keep the item with `enrollment_id = null`; it appears
  in review flagged "assign a course". Nothing is dropped.
- **Kind:** keyword scan of the summary — `quiz`→quiz, `exam|midterm|final`→exam,
  `paper|essay`→paper, `presentation`→presentation, `project`→project,
  `problem set|pset`→problem_set, `reading`→reading, else `assignment`. This is
  what routes exams/quizzes (with a due_time) to the dashed assessment block and
  everything else to the Due-strip chip.
- **Title:** `name` = cleaned `SUMMARY` (course tag stripped). Structured
  Series/Number/Descriptor stay empty; `override_title` holds the feed title so
  the review editor shows something sensible.

## De-dupe & reconciliation ("keep")

For each parsed event, in order:
1. **By `ext_uid`:** existing row with this UID → it's ours; update date/time if
   changed (see policy). Done.
2. **Adopt a prior scrape:** else find an existing `source='canvas'` row for the
   same `enrollment_id` with the same `due_on` and a normalized-title match. If
   found, **stamp its `ext_uid`** with this event's UID (link it) instead of
   inserting — no duplicate, and it's idempotent henceforth.
3. **Insert:** else insert a new `pending` row with `ext_uid`, `source='canvas'`.

Items the feed never carries (REAL 6101's PDF-derived deadlines) match nothing in
step 1–2 for feed events and are simply left alone — kept.

## Update / delete policy

- **Insert** new UIDs. **Update** only `due_on` / `due_time` on rows the sync owns
  (has `ext_uid`) when Canvas moves the date.
- **Never** auto-delete: a deadline that disappears from the feed stays (safer
  than removing something already approved); the user deletes manually.
- **Never** overwrite user edits: `status` (approve/reject), `override_title`,
  `series/number/descriptor`, `target_on/target_time`, `done` are never touched by
  sync. Sync writes date/time + ext_uid only.

## Scheduling

- New edge env var `CANVAS_CRON_SECRET` (random 32+ chars).
- `pg_cron` nightly job (e.g. `05:30 UTC` ≈ 1:30 am ET) runs a small SQL wrapper
  that calls `pg_net`:

```sql
select cron.schedule('carnelian-canvas-sync', '30 5 * * *', $$
  select net.http_post(
    url    := 'https://uhwdnmbxiopfysodydty.supabase.co/functions/v1/carnelian',
    headers:= '{"content-type":"application/json"}'::jsonb,
    body   := jsonb_build_object('action','canvas_sync','cron_secret', current_setting('carnelian.cron_secret', true))
  );
$$);
```

The cron secret is provided to Postgres via a DB setting
(`alter database … set carnelian.cron_secret = '…'`) so it isn't inlined in the
job definition, and matches the edge function's `CANVAS_CRON_SECRET`.

## App surface

Because the URL is configured server-side (pasted once), there is **no URL field**
in the UI. Add a compact **"Canvas deadlines"** status line beside the Google
Calendar controls in the schedule tools:

- shows `last_sync_at` (relative) + pending-from-canvas count,
- a **Sync now** button → `{action:"canvas_sync", token}` → refresh the review
  queue and status on return,
- reflects `{error}` (e.g. "feed not reachable") inline.

New client edge action wrapper: `canvasSync()` and a `canvas_status` read (or fold
status into the existing `load`). Keep it minimal.

## Security

- `feed_url` is a bearer secret → only in `carnelian.canvas_config`; never sent to
  the client, never logged, never committed. Set via SQL at implementation time;
  never echoed back in chat.
- `CANVAS_CRON_SECRET` is an edge env secret; the DB copy lives in a database
  setting, not the job SQL.
- `canvas_sync` is the only new capability; it reads the feed and writes only
  `assignments` + `canvas_config`.

## Testing / validation

- Parser unit-checks against a captured sample of the real feed (2–3 VEVENTs):
  UTC and all-day DTSTART, folded lines, escaped text.
- ET conversion: an Aug (EDT −4) and a Jan (EST −5) event land on the right
  local date/time.
- Idempotency: run sync twice → second run reports 0 added.
- Reconciliation: a feed event matching one of the existing 38 adopts it (adopted
  count > 0, no new row).
- "Sync now" round-trip in the authenticated preview; review queue reflects new
  pending items; a quiz/exam with due_time renders as the dashed assessment block.

## Validated during build (not blocking design)

- Exact `SUMMARY`/course-tag format in the user's actual feed (Canvas varies) —
  fetch a couple of real events once the URL is provided and tune the course-hint
  regex. Worst case degrades to unmapped-pending, never data loss.
