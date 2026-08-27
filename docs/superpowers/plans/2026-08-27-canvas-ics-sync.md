# Canvas .ics Deadline Sync — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Nightly server-side sync of the user's tokenized Canvas calendar feed into `carnelian.assignments` as pending review items — no Chrome, no login.

**Architecture:** `pg_cron` + `pg_net` invoke a new `canvas_sync` action on the existing `carnelian` Deno edge function, which fetches the stored feed URL, parses `VEVENT`s (pure module `ical.ts`), maps each to an enrollment, de-dupes against existing items, and upserts as `status='pending'`. A "Sync now" button hits the same action with the session token.

**Tech Stack:** Deno edge function (Supabase), Postgres (`carnelian` schema), pg_cron/pg_net, static `index.html` client. Parser unit-tested with Node 24's built-in `node --test` (Node runs `.ts` via type-stripping; the module is isomorphic — Deno in prod, Node in test).

## Global Constraints

- Feed URL is a **bearer secret**: stored only in `carnelian.canvas_config`, never sent to the client, never logged, never committed. (from spec §Security)
- `ext_uid` written only by the server sync; kept out of `COLS.assignments`. (spec §Data model)
- Sync never overwrites user edits (`status`, `override_title`, `series/number/descriptor`, `target_*`, `done`) and never auto-deletes. (spec §Update policy)
- Edge function deploy: include **all** files (`index.ts`, `ical.ts`) via `deploy_edge_function`, `verify_jwt:false` (function does its own auth). (memory)
- UI copy: bare, factual — no marketing/filler. (memory: no-fluff-language)
- Project ref: `uhwdnmbxiopfysodydty`. Function URL: `https://uhwdnmbxiopfysodydty.supabase.co/functions/v1/carnelian`.

---

### Task 1: Migration — `ext_uid` + `canvas_config`

**Files:**
- Create: `supabase/migrations/20260827_canvas_sync.sql`

**Interfaces:**
- Produces: column `carnelian.assignments.ext_uid text`; partial unique index `assignments_ext_uid_uidx`; table `carnelian.canvas_config(id, feed_url, last_sync_at, last_result, updated_at)` seeded with row id=1.

- [ ] **Step 1: Write the migration** (DDL from spec §Data model — `ext_uid` + index + `canvas_config` + seed row).
- [ ] **Step 2: Apply** via `apply_migration` name `canvas_sync`.
- [ ] **Step 3: Verify** — `execute_sql`: assert `ext_uid` column exists and `canvas_config` has 1 row. Expected: both present.
- [ ] **Step 4: Commit** the migration file.

---

### Task 2: `ical.ts` parser module + unit tests

**Files:**
- Create: `supabase/functions/carnelian/ical.ts`
- Test: `supabase/functions/carnelian/ical.test.ts`

**Interfaces (Produces — exact signatures index.ts will import):**
- `unfoldIcal(text: string): string` — CRLF-normalize + unfold continuation lines.
- `parseVEvents(text: string): RawEvent[]` where `RawEvent = {uid, summary, dtstart, dtend, url, description}` (all string, raw property values incl. params before `:` captured as `{value, params}` internally but returned flattened: `dtstart` keeps its param prefix, e.g. `"VALUE=DATE:20260828"` or `":20260828T035959Z"` → store the full right-hand side including any `;PARAM`).
- `icalDateToET(raw: string): {due_on: string|null, due_time: string|null}` — handles `…Z` (UTC→ET), `VALUE=DATE` (all-day → time null), `TZID=America/New_York` (wall-clock). ET offset from US DST rules for the date.
- `normCode(s: string): string` — uppercase, strip non-alphanumeric, drop leading term tokens (`FA26`,`SP27`,`SU26`,`WI27`) → e.g. `"FA26-REAL-6640-001"` → `REAL6640001`; also expose `courseKey(s)` returning just `SUBJECT+NUMBER` (`REAL6640`).
- `guessKind(summary: string): string` — keyword → one of the app's kinds; default `"assignment"`.
- `cleanSummary(summary: string): string` — unescape iCal, strip trailing course-tag `[...]`/`(...)`.

- [ ] **Step 1: Write failing tests** `ical.test.ts` using `node:test` + `node:assert/strict`, importing from `./ical.ts`. Cases:
  - folded+escaped `SUMMARY` unfolds and unescapes;
  - UTC `DTSTART:20260828T035959Z` → `{due_on:"2026-08-28", due_time:"23:59"}` **wait: 03:59:59Z on 8/28 = 23:59 ET on 8/27** → assert `{due_on:"2026-08-27", due_time:"23:59"}` (EDT −4);
  - Jan UTC `DTSTART:20270115T045959Z` → `{due_on:"2027-01-14", due_time:"23:59"}` (EST −5);
  - all-day `DTSTART;VALUE=DATE:20260828` → `{due_on:"2026-08-28", due_time:null}`;
  - `parseVEvents` on a 2-event sample returns 2 with correct uids;
  - `courseKey("FA26-REAL-6640-001")==="REAL6640"`;
  - `guessKind("Quiz 3")==="quiz"`, `guessKind("Final Exam")==="exam"`, `guessKind("Case Write-up")==="assignment"`.
- [ ] **Step 2: Run, expect fail** — `node --test supabase/functions/carnelian/ical.test.ts`. Expected: FAIL (module/exports missing).
- [ ] **Step 3: Implement `ical.ts`** — pure functions per interfaces; no Deno/Node-specific APIs (only `Date`, `RegExp`, `String`).
- [ ] **Step 4: Run, expect pass** — same command. Expected: PASS all.
- [ ] **Step 5: Commit** `ical.ts` + `ical.test.ts`.

---

### Task 3: Edge function `canvas_sync` + `canvas_status` actions

**Files:**
- Modify: `supabase/functions/carnelian/index.ts` (import `./ical.ts`; add actions; add cron-secret auth branch)

**Interfaces:**
- Consumes: `ical.ts` exports (Task 2); `carnelian.canvas_config`, `assignments`, `enrollments`, `terms` (Task 1 + existing).
- Produces: POST actions `canvas_status` → `{ok, configured, last_sync_at, last_result, pending_canvas}`; `canvas_sync` → `{ok, added, updated, adopted, unmapped, total}` (or `{error}`). Auth: valid session token **or** `body.cron_secret === Deno.env.get("CANVAS_CRON_SECRET")`.

- [ ] **Step 1: Add `canvasSync()` server logic** — fetch `feed_url` (timeout 10s, UA header); `parseVEvents`; load in-scope enrollments (`status<>'wishlist'`, term `ends_on` null or ≥ today); load existing assignments for those enrollments; per event (due ≥ today−7d): map course (`courseKey` vs normalized `enrollments.code`), `guessKind`, reconcile (ext_uid → adopt scrape by enrollment+due_on+title → insert), collect writes. Apply; write `last_sync_at`/`last_result`. Never touch user-edited fields.
- [ ] **Step 2: Wire the actions + cron auth** — before the `authed()` gate, allow `canvas_sync` when `cron_secret` matches env; otherwise it falls through to the token gate. Add `canvas_status` (authed).
- [ ] **Step 3: Deploy** — `deploy_edge_function` name `carnelian`, `verify_jwt:false`, files: current `index.ts` + `ical.ts`.
- [ ] **Step 4: Set secrets/config** — set `CANVAS_CRON_SECRET` env (Supabase function secret); store the user-provided `feed_url` into `canvas_config` via `execute_sql` (never echoed/committed).
- [ ] **Step 5: Verify** — POST `canvas_status` with a session token → `configured:true`. POST `canvas_sync` → counts; `execute_sql` shows new `source='canvas'` pending rows with `ext_uid`. Re-run → `added:0` (idempotent).
- [ ] **Step 6: Commit** `index.ts` + `ical.ts` (already committed) — commit `index.ts` change.

---

### Task 4: Scheduling — pg_cron nightly

**Files:** none (DB state via `execute_sql`; documented here, secret not committed).

- [ ] **Step 1: Store secret for the job** — `alter database postgres set carnelian.cron_secret = '<CANVAS_CRON_SECRET>';` (session-visible via `current_setting`).
- [ ] **Step 2: Schedule** — `cron.schedule('carnelian-canvas-sync','30 5 * * *', $$ select net.http_post(url:=…, headers:=…, body:=jsonb_build_object('action','canvas_sync','cron_secret', current_setting('carnelian.cron_secret', true))); $$);`
- [ ] **Step 3: Verify** — `select jobname, schedule from cron.job where jobname='carnelian-canvas-sync';` Expected: 1 row. (Optionally trigger once and check `cron.job_run_details`.)

---

### Task 5: App UI — status line + "Sync now"

**Files:**
- Modify: `index.html` (client `canvasSync()`/`canvasStatus()`; a compact "Canvas deadlines" row beside the schedule/Google-calendar tools)

**Interfaces:**
- Consumes: edge actions `canvas_status`, `canvas_sync` (Task 3).
- Produces: `canvasSync()` client fn that posts, then refreshes assignments + review queue + the status line.

- [ ] **Step 1: Add client fns** `canvasStatus()` and `canvasSync()` (reuse the existing `api(action, body)` helper/token plumbing).
- [ ] **Step 2: Render** a status line: `Canvas deadlines · synced <relative> · <n> pending` + a **Sync now** button; bare copy. Place near the Google Calendar controls. On sync: disable button, show a spinner/label, then reload data + re-render review queue + status; show `{error}` inline.
- [ ] **Step 3: Verify** in the authenticated preview (localhost + injected token): button triggers sync, status updates, new pending items appear in the review queue; a synced quiz/exam with due_time renders as the dashed assessment block after approval.
- [ ] **Step 4: Commit** `index.html`.

---

### Task 6: End-to-end validation + tune course mapping

**Files:** possibly Modify `ical.ts` (tune `normCode`/`courseKey`/course-hint regex against the real feed).

- [ ] **Step 1: Capture real format** — fetch the live feed via the deployed function (or inspect a returned raw sample) and read 2–3 real `SUMMARY`/`DESCRIPTION` values to see how the course is tagged.
- [ ] **Step 2: Tune** the course-hint extraction so most events auto-map; re-run parser unit tests (add a real-format case). Redeploy if `ical.ts` changed.
- [ ] **Step 3: Assert outcomes** — `execute_sql`: `adopted > 0` against the existing 38 (no duplicate rows for the same enrollment+due_on+title); second `canvas_sync` reports `added:0`; unmapped count is acceptable/expected; REAL 6101 PDF items untouched.
- [ ] **Step 4: Commit** any `ical.ts` tuning; update `docs/TODO.md`/memory (`carnelian-assignments-feature`) with "Canvas .ics auto-sync shipped".

---

## Self-Review

- **Spec coverage:** data model → T1; parse/ET → T2; fetch+actions+auth → T3; scheduling → T4; app surface → T5; mapping/dedupe/idempotency validation → T3/T6; security (feed_url server-only, cron secret) → T3/T4 + Global Constraints. All spec sections mapped.
- **Type consistency:** `courseKey`/`normCode`/`guessKind`/`icalDateToET`/`parseVEvents`/`unfoldIcal`/`cleanSummary` used identically in T2 (definition) and T3 (consumption). Action names `canvas_sync`/`canvas_status` consistent across T3/T4/T5.
- **Placeholders:** none — the one deliberately deferred item (exact real-feed course-tag format) is an explicit tuning task (T6) with a fallback (unmapped-pending), per spec.
