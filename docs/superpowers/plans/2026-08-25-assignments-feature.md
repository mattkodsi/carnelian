# Assignments Feature Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Per-course assignments/deadlines, entered via structured fields that compose a standardized title, stored server-side, that auto-populate the Schedule week view (timed blocks for exams/quizzes, all-day chips for everything else), with a review queue for pre-loaded Canvas items and a checkable done state.

**Architecture:** Extend the existing (empty, dormant) `carnelian.assignments` table and its generic `upsert`/`delete`/`load` wiring in the edge function. All new logic is client-side in `index.html`: a deterministic title composer, a Planner course → assignment list + editor, a review queue, and Schedule rendering. Canvas data is imported once via a Node script that decomposes scraped titles into the structured fields and inserts them as `pending`.

**Tech Stack:** Single-file vanilla-JS app (`index.html`), Supabase Deno edge function (`supabase/functions/carnelian/index.ts`, deployed inline via the Supabase MCP `deploy_edge_function`), Postgres (`carnelian` schema). No frontend build or test runner.

## Global Constraints

- **No test runner exists.** "Tests" are adapted per task: pure JS functions get a Node script under the scratchpad dir (`node <script>.js`, red→green); backend changes get a curl functional test against the live edge function using a minted-then-revoked session token; UI gets the browser verification workflow (temp `python3 -m http.server 8792` in the repo root, `carn_token` injected in localStorage, DOM assertions + screenshots).
- **Edge function:** must stay deployed with `verify_jwt:false`; deploying requires inlining the FULL `index.ts` via the Supabase MCP `deploy_edge_function` (no CLI). Health-check after: `curl -X POST .../carnelian -d '{"action":"status"}'` → `{"ok":true,"initialized":true}`.
- **Project ref:** `uhwdnmbxiopfysodydty`. Edge fn URL: `https://uhwdnmbxiopfysodydty.supabase.co/functions/v1/carnelian`.
- **DB hygiene:** don't hammer the live backend; batch verification, revoke test tokens, and pkill temp servers when done.
- **Title standardization is the point:** the stored `name` (display title) is ALWAYS the composed label unless `override_title` is set. Course code and dates are NEVER in the title.
- **Personal data stays out of git:** the scraped list (`scratchpad/canvas_fall2026_aggregated.json`) and the importer are scratchpad-only, never committed.
- Match existing `index.html` conventions: `$()`, `esc()`, `openModal()`/`closeModal()`, custom `enhanceDD()` dropdowns, the `#acDayModal` detail-sheet pattern, and the schedule-helpers block near `acalShort`.

---

## Existing facts to build on (verified)

- `carnelian.assignments` exists, **0 rows**, current columns include: `id`, `enrollment_id`, `name`, `weight`, `score`, `due_on`, `sort` (`weight`/`score` unused by the app — leave them, nullable).
- Edge fn `COLS.assignments = ["enrollment_id","name","weight","score","due_on","sort"]` (index.ts ~line 98).
- Generic actions already work for any allow-listed table (after the auth gate): `upsert` (`api("upsert",{table,row})`, insert when `row` has no `id`, update when it does, returns the row) and `delete` (`api("delete",{table,id})`).
- `load` already returns `assignments` in `DB` (index.ts ~line 564/570). So `DB.assignments` is available client-side once populated.
- `DB.enrollments` rows have `id`, `code` (e.g. "REAL 6101"), `title`, `term_id`, `meetings` (array of meeting objects the Schedule renders).
- Schedule helpers live near `acalShort` (~line 1253); the all-day overlay strip is built in `renderSchedule` (`adcols`/`ad-col`/`adchip`, ~line 1395); the day detail sheet is `openAcadDay`/`#acDayModal` (~line 1285). Class meeting blocks render in the grid (search `renderSchedule` grid loop).

---

## Task 1: Extend the assignments table + edge allowlist

**Files:**
- Create: `supabase/migrations/20260825_assignments_deadlines.sql`
- Modify: `supabase/functions/carnelian/index.ts` (the `COLS.assignments` line)

**Interfaces:**
- Produces: `carnelian.assignments` columns `kind, series, number, descriptor, override_title, due_time, duration_min, status, source, done` (plus existing `enrollment_id, name, due_on, sort`); edge `upsert`/`delete`/`load` accept them.

- [ ] **Step 1: Write the migration**

Create `supabase/migrations/20260825_assignments_deadlines.sql`:

```sql
-- Repurpose the dormant (empty) carnelian.assignments table for the deadlines
-- feature: structured naming fields + scheduling + review/done state.
alter table carnelian.assignments
  add column if not exists kind           text,
  add column if not exists series         text,
  add column if not exists number         int,
  add column if not exists descriptor     text,
  add column if not exists override_title text,
  add column if not exists due_time       time,
  add column if not exists duration_min   int,
  add column if not exists status         text not null default 'active',
  add column if not exists source         text not null default 'manual',
  add column if not exists done           boolean not null default false;

-- Guard the small controlled vocabularies at the DB level.
alter table carnelian.assignments
  drop constraint if exists assignments_status_chk,
  add  constraint assignments_status_chk check (status in ('pending','active','done'));
alter table carnelian.assignments
  drop constraint if exists assignments_source_chk,
  add  constraint assignments_source_chk check (source in ('manual','canvas'));
```

- [ ] **Step 2: Apply the migration**

Apply via the Supabase MCP `apply_migration` (project `uhwdnmbxiopfysodydty`, name `assignments_deadlines`, the SQL above).

- [ ] **Step 3: Verify the columns exist**

Run via Supabase MCP `execute_sql`:
```sql
select column_name from information_schema.columns
where table_schema='carnelian' and table_name='assignments' and column_name in
('kind','series','number','descriptor','override_title','due_time','duration_min','status','source','done')
order by column_name;
```
Expected: 10 rows.

- [ ] **Step 4: Extend the edge allowlist**

In `supabase/functions/carnelian/index.ts`, replace the `assignments` line in `COLS`:
```ts
  assignments: ["enrollment_id","name","kind","series","number","descriptor","override_title","due_on","due_time","duration_min","status","source","done","weight","score","sort"],
```

- [ ] **Step 5: Redeploy the edge function**

Deploy the FULL inlined `index.ts` via Supabase MCP `deploy_edge_function` (name `carnelian`, `verify_jwt:false`). Then health-check:
```bash
curl -s -X POST https://uhwdnmbxiopfysodydty.supabase.co/functions/v1/carnelian -H 'content-type: application/json' -d '{"action":"status"}'
```
Expected: `{"ok":true,"initialized":true}`

- [ ] **Step 6: Functional test (mint token → upsert → load → delete → revoke)**

Mint a temporary token (Supabase `execute_sql`), pick a real enrollment id, then:
```bash
TOK="<raw token>"; FN="https://uhwdnmbxiopfysodydty.supabase.co/functions/v1/carnelian"
EID=$(curl -s -X POST $FN -H 'content-type: application/json' -d "{\"action\":\"load\",\"token\":\"$TOK\"}" | python3 -c "import sys,json;print(json.load(sys.stdin)['data']['enrollments'][0]['id'])")
# insert
curl -s -X POST $FN -H 'content-type: application/json' -d "{\"action\":\"upsert\",\"token\":\"$TOK\",\"table\":\"assignments\",\"row\":{\"enrollment_id\":$EID,\"name\":\"__TEST__ Quiz 1\",\"kind\":\"quiz\",\"number\":1,\"due_on\":\"2026-09-10\",\"due_time\":\"09:25\",\"duration_min\":30,\"status\":\"active\",\"source\":\"manual\"}}"
# confirm it loads back, then delete it by id, then revoke token
```
Expected: upsert returns the row with an `id`; `load` includes it; delete removes it. Revoke the token and delete any leftover `__TEST__` row.

- [ ] **Step 7: Commit**

```bash
git add supabase/migrations/20260825_assignments_deadlines.sql supabase/functions/carnelian/index.ts
git commit -m "Assignments: extend table + edge allowlist for the deadlines feature"
```

---

## Task 2: Title composer + kind vocabulary (client) + Node test

**Files:**
- Modify: `index.html` (add to the schedule-helpers block, right after `acalShort`, ~line 1253)
- Test: `scratchpad/test_compose.js` (Node, not committed)

**Interfaces:**
- Produces (global functions in `index.html`):
  - `ASG_KINDS` — ordered array `[{v,label,timed}]` of the controlled vocabulary.
  - `KIND_LABEL(kind) -> string`, `KIND_TIMED(kind) -> boolean`.
  - `asgTitleCase(s) -> string`.
  - `composeAssignment({kind,series,number,descriptor,override_title}) -> string`.
- Consumed by Tasks 3, 4, 5, 6, 8.

- [ ] **Step 1: Write the failing Node test**

Create `scratchpad/test_compose.js`. Paste the intended implementation of the four helpers at the top of the file (so the test is self-contained), then the assertions:

```js
const ASG_KINDS=[
  {v:'exam',label:'Exam',timed:true},{v:'quiz',label:'Quiz',timed:true},
  {v:'homework',label:'Homework',timed:false},{v:'assignment',label:'Assignment',timed:false},
  {v:'problem_set',label:'Problem Set',timed:false},{v:'paper',label:'Paper',timed:false},
  {v:'presentation',label:'Presentation',timed:false},{v:'project',label:'Project',timed:false},
  {v:'reading',label:'Reading',timed:false},{v:'draft',label:'Draft',timed:false},
  {v:'survey',label:'Survey',timed:false},{v:'other',label:'Other',timed:false},
];
const _K=Object.fromEntries(ASG_KINDS.map(k=>[k.v,k]));
const KIND_LABEL=k=>(_K[k]||_K.other).label;
const KIND_TIMED=k=>!!(_K[k]||{}).timed;
const SMALL=new Set(['a','an','the','and','or','for','to','of','in','on','at','vs','via']);
function asgTitleCase(s){ s=String(s||'').trim().replace(/\s+/g,' '); if(!s) return '';
  return s.split(' ').map((w,i)=>{ if(/[A-Z].*[A-Z]/.test(w)||/\d/.test(w)) return w; const lw=w.toLowerCase();
    if(i>0 && SMALL.has(lw)) return lw; return lw.charAt(0).toUpperCase()+lw.slice(1); }).join(' '); }
function composeAssignment(a){ const ov=(a.override_title||'').trim(); if(ov) return ov;
  const lead=(a.series&&a.series.trim())? a.series.trim() : KIND_LABEL(a.kind);
  const num=(a.number!=null && a.number!=='')? ' '+a.number : '';
  const desc=(a.descriptor&&a.descriptor.trim())? ': '+asgTitleCase(a.descriptor) : '';
  return lead+num+desc; }

const cases=[
  [{kind:'quiz',number:2}, 'Quiz 2'],
  [{kind:'exam',series:'Midterm Exam'}, 'Midterm Exam'],
  [{kind:'assignment',series:'Writing Case',number:3,descriptor:'leasing memo'}, 'Writing Case 3: Leasing Memo'],
  [{kind:'homework',descriptor:'Cover Letter Draft'}, 'Homework: Cover Letter Draft'],
  [{kind:'quiz',number:2,override_title:'Pre-Course Survey'}, 'Pre-Course Survey'],
  [{kind:'other',descriptor:'market analysis pitch'}, 'Other: Market Analysis Pitch'],
];
let fail=0;
for(const [a,exp] of cases){ const got=composeAssignment(a); if(got!==exp){ fail++; console.log('FAIL',JSON.stringify(a),'=>',got,'expected',exp); } }
console.log(fail? (fail+' FAILURES') : 'ALL PASS ('+cases.length+')');
process.exit(fail?1:0);
```

- [ ] **Step 2: Run it (verify it passes as a spec of intended behavior)**

Run: `node scratchpad/test_compose.js`
Expected: `ALL PASS (6)`. (If any FAIL, fix the helper logic in the test file until green — this file is the reference implementation.)

- [ ] **Step 3: Port the validated helpers into `index.html`**

Insert the exact `ASG_KINDS`, `_K`, `KIND_LABEL`, `KIND_TIMED`, `SMALL`, `asgTitleCase`, `composeAssignment` from the (now-green) test file into `index.html` immediately after the `acalShort` function (~line 1253). Keep names identical.

- [ ] **Step 4: Verify in the browser console (no syntax errors, composer works)**

Start temp server, load app with an injected token (see Global Constraints), then `javascript_tool`:
```js
composeAssignment({kind:'assignment',series:'Writing Case',number:3,descriptor:'leasing memo'})
```
Expected: `"Writing Case 3: Leasing Memo"`.

- [ ] **Step 5: Commit**

```bash
git add index.html
git commit -m "Assignments: title composer + kind vocabulary"
```

---

## Task 3: Client data helpers

**Files:**
- Modify: `index.html` (schedule-helpers block, after the composer)

**Interfaces:**
- Consumes: `DB.assignments`, `DB.enrollments`, `composeAssignment`, `KIND_TIMED`, `SCHED_WEEK`, `mondayOf`.
- Produces:
  - `asgFor(enrollmentId) -> Array` — that course's assignments, sorted by `due_on` then `due_time`.
  - `asgTitle(a) -> string` — `a.name` if set else `composeAssignment(a)`.
  - `asgWeek(mon) -> {chips:[{a,eid,code,color}], blocks:[{a,eid,code,color}]}` — `active`+`done` assignments whose `due_on` is in the Mon–Fri week; `blocks` = timed kinds with a `due_time`, `chips` = the rest.

- [ ] **Step 1: Implement the helpers**

Add to `index.html` after the composer. Use the existing color lookup the grid uses for a course (find how class blocks get their color in `renderSchedule` — reuse that function, referenced below as `courseColor(enrollment)`):

```js
function asgTitle(a){ return (a && a.name) ? a.name : composeAssignment(a||{}); }
function asgFor(eid){ return (DB.assignments||[]).filter(a=>String(a.enrollment_id)===String(eid))
  .sort((x,y)=> String(x.due_on||'~').localeCompare(String(y.due_on||'~')) || String(x.due_time||'~').localeCompare(String(y.due_time||'~'))); }
function asgWeek(mon){ const start=new Date(mon), end=new Date(mon); end.setDate(end.getDate()+4);
  const iso=d=>d.toISOString().slice(0,10); const s=iso(start), e=iso(end);
  const enrollById=Object.fromEntries((DB.enrollments||[]).map(en=>[String(en.id),en]));
  const chips=[], blocks=[];
  for(const a of (DB.assignments||[])){ if(a.status==='pending') continue; if(!a.due_on) continue;
    if(a.due_on<s||a.due_on>e) continue; const en=enrollById[String(a.enrollment_id)]; if(!en) continue;
    const row={a, eid:a.enrollment_id, code:en.code, color:courseColor(en)};
    if(KIND_TIMED(a.kind) && a.due_time) blocks.push(row); else chips.push(row); }
  return {chips, blocks}; }
```

- [ ] **Step 2: Verify in the browser**

With a course that has ≥1 active assignment (create one via the Task 1 curl path first if needed), in `javascript_tool`:
```js
(function(){ return JSON.stringify({week:asgWeek(SCHED_WEEK||mondayOf(new Date())).chips.map(c=>c.code+':'+asgTitle(c.a))}); })()
```
Expected: the test assignment appears if its `due_on` is in the current week.

- [ ] **Step 3: Commit**

```bash
git add index.html
git commit -m "Assignments: client data helpers (asgFor/asgWeek/asgTitle)"
```

---

## Task 4: Planner — course assignment list + editor

**Files:**
- Modify: `index.html` (Planner render for a course row; new modal markup + handlers + CSS)

**Interfaces:**
- Consumes: `asgFor`, `asgTitle`, `composeAssignment`, `ASG_KINDS`, `KIND_TIMED`, `api`, `DB`.
- Produces: `openCourseAssignments(enrollmentId)`, `openAsgEditor(enrollmentId, assignmentOrNull)`, `saveAsg(row)`, `deleteAsg(id)`, `toggleAsgDone(a)`.

- [ ] **Step 1: Add the entry point in the Planner**

Find where a course/enrollment row renders in the Planner (search the planner render function). Add a tappable affordance (e.g. a small "assignments" button/icon in the row, matching existing row controls) that calls `openCourseAssignments(en.id)`. If the row already has a click handler, add a dedicated control so it doesn't conflict.

- [ ] **Step 2: Build the list modal**

Add a modal (`#asgListModal`) following the `#acDayModal` pattern (`openModal`/`closeModal`, `lockScroll`). `openCourseAssignments(eid)` fills:
- Header: enrollment `code` + `title`.
- A "review" strip when `asgFor(eid).some(a=>a.status==='pending')` (Task 5 fills its behavior).
- Rows from `asgFor(eid)`, each showing: done checkbox, composed title (`asgTitle(a)`), date (+ time for timed), and edit/delete controls. `done` rows dimmed + struck.
- "Add assignment" button → `openAsgEditor(eid, null)`.

Row example (build with `esc()`):
```js
`<div class="asg-row${a.done?' done':''}${a.status==='pending'?' pending':''}">
  <button class="asg-check" data-id="${a.id}" aria-label="Done">${a.done?ICO.check:''}</button>
  <div class="asg-main"><div class="asg-t">${esc(asgTitle(a))}</div>
    <div class="asg-meta">${esc(fmtAsgDate(a))}</div></div>
  <button class="asg-edit" data-id="${a.id}">Edit</button>
</div>`
```
Add `fmtAsgDate(a)` (date via existing `ACAL_MONTHS`, plus `a.due_time` in 12h if timed).

- [ ] **Step 3: Build the editor form**

`openAsgEditor(eid, a)` opens `#asgEditModal` with fields:
- **Kind** — `<select>` from `ASG_KINDS` (enhance with `enhanceDD`).
- **Series** — text input with a `<datalist>` of distinct `series` values already used in `asgFor(eid)` (autocomplete/reuse).
- **Number** — `<input type="number">`.
- **Descriptor** — text input.
- **Live title preview** — a read-only element updated on every input via `composeAssignment(readForm())`.
- **Override** — a checkbox that reveals a text input; when checked, its value becomes `override_title`.
- **Date** — `<input type="date">` (`due_on`).
- **Time + Duration** — shown only when `KIND_TIMED(kind)`; `due_time` (`<input type="time">`) and `duration_min` (number, default 30 for quiz / 75 for exam).
- Save / Cancel / (Delete when editing).

- [ ] **Step 4: Wire save/delete/done**

```js
async function saveAsg(row){ const saved=(await api("upsert",{table:"assignments",row})).row;
  const i=(DB.assignments||[]).findIndex(x=>String(x.id)===String(saved.id));
  if(i>=0) DB.assignments[i]=saved; else (DB.assignments=DB.assignments||[]).push(saved);
  if(CUR==="schedule") renderSchedule(); }
async function deleteAsg(id){ await api("delete",{table:"assignments",id});
  DB.assignments=(DB.assignments||[]).filter(x=>String(x.id)!==String(id)); if(CUR==="schedule") renderSchedule(); }
async function toggleAsgDone(a){ await saveAsg({id:a.id, done:!a.done}); }
```
On Save from the editor, build `row` from the form: always set `name = composeAssignment(form)`, include `kind, series, number, descriptor, override_title, due_on, due_time, duration_min`, set `status` (`active` for manual adds), `source:'manual'`, and `id` when editing. Re-render the list modal after save.

- [ ] **Step 5: CSS**

Add styles for `.asg-row`, `.asg-row.done` (opacity + line-through on `.asg-t`), `.asg-check`, `.asg-meta`, and the editor form, matching existing modal/token styles. Theme-aware via existing CSS vars.

- [ ] **Step 6: Browser verification**

Start temp server, inject token, load app → Planner. Open a course → Add assignment → fill Kind=Quiz, Number=2, Date → confirm the **live preview** shows "Quiz 2" → Save. Verify:
```js
(function(){ const a=(DB.assignments||[]).find(x=>x.name==='Quiz 2'); return JSON.stringify(a&&{name:a.name,kind:a.kind,status:a.status,source:a.source}); })()
```
Expected: `{name:"Quiz 2",kind:"quiz",status:"active",source:"manual"}`. Screenshot the list. Toggle done → row dims. Delete it → gone. (Clean up any rows created.)

- [ ] **Step 7: Commit**

```bash
git add index.html
git commit -m "Assignments: Planner course list + structured editor with live preview"
```

---

## Task 5: Review queue (pending → approve/reject)

**Files:**
- Modify: `index.html` (Planner row badge + the list modal's review strip + handlers)

**Interfaces:**
- Consumes: `asgFor`, `api`, `DB`, `saveAsg`, `deleteAsg`.
- Produces: `approveAsg(a)`, `rejectAsg(a)`, `pendingCount(eid)`.

- [ ] **Step 1: Pending badge on the Planner row**

```js
function pendingCount(eid){ return (DB.assignments||[]).filter(a=>String(a.enrollment_id)===String(eid)&&a.status==='pending').length; }
```
In the Planner course row, when `pendingCount(en.id)>0`, render a small badge `"${n} to review"` next to the assignments control.

- [ ] **Step 2: Review actions**

```js
async function approveAsg(a){ await saveAsg({id:a.id, status:'active'}); }
async function rejectAsg(a){ await deleteAsg(a.id); }
```

- [ ] **Step 3: Review strip in the list modal**

When `openCourseAssignments(eid)` sees pending items, render them in a distinct "To review" section at the top: each pending row shows the composed title + date + **Approve** / **Reject** buttons (and an **Edit** to fix before approving). Approving moves it into the active list; rejecting removes it. Re-render the modal after each action. Pending items never render on the Schedule (guaranteed by `asgWeek` skipping `status==='pending'`).

- [ ] **Step 4: Browser verification**

Insert two `pending` rows for a course via the Task 1 curl path (`status:'pending'`). Reload app → Planner shows "2 to review". Open course → approve one (→ moves to active, appears on Schedule), reject the other (→ gone). Verify:
```js
(function(){ const e=/*that eid*/; return JSON.stringify({pending:pendingCount(e), active:asgFor(e).filter(a=>a.status==='active').length}); })()
```
Expected: pending drops to 0. Screenshot. Clean up rows.

- [ ] **Step 5: Commit**

```bash
git add index.html
git commit -m "Assignments: review queue (pending badge + approve/reject)"
```

---

## Task 6: Schedule rendering (chips + timed blocks + done dimming)

**Files:**
- Modify: `index.html` (`renderSchedule` overlay strip + grid; `openAcadDay`-style detail; `buildSchedCanvas` share image)

**Interfaces:**
- Consumes: `asgWeek`, `asgTitle`, `KIND_TIMED`, existing grid geometry (`dateOf`, `SDAYS`, hour rows, `courseColor`).
- Produces: assignment chips in the all-day strip + timed assignment blocks in the grid + detail on tap; done items dimmed.

- [ ] **Step 1: Chips in the all-day strip**

In `renderSchedule`, where `adcols`/`ad-col` are built (~line 1395), also fold in `asgWeek(SCHED_WEEK).chips` for each day: render an assignment chip (class `.adchip.asg`, distinct accent from academic `.adchip`) with `esc(asgTitle(row.a))`, a small course-color dot, and `.done` (dim + strike) when `row.a.done`. Respect the existing 2-per-day cap + "+N more", and include assignment items in the day's `openAcadDay`/detail list (extend it to show assignment rows with their date/time and a done indicator). Keep single-line ellipsis like the academic chips.

- [ ] **Step 2: Timed blocks in the grid**

In the grid meeting loop, after drawing class meetings for a day, draw `asgWeek(SCHED_WEEK).blocks` for that day: position by `due_time` (start) with height from `duration_min` (fallback 30) using the same y-math as class blocks. Style distinctly from classes: course color, but marked with the kind (`EXAM`/`QUIZ`) and an outlined/hatched treatment so it reads as an assessment, not a class. Dim + strike when `done`. Tapping opens the same detail sheet.

- [ ] **Step 3: Share image**

In `buildSchedCanvas`, include assignment chips in the academic band (reuse the band's `wrapLines`/box drawing with the assignment accent) and draw timed assignment blocks in the grid like class blocks with the assessment marker. Done items render dimmed. (Match the week-mode `d.wk` path.)

- [ ] **Step 4: CSS**

Add `.adchip.asg` (+ `.done`) accent distinct from academic + no-class chips, and a grid `.sched-asg` block style (outline/marker) distinct from `.sched-ev` class blocks. Theme-aware.

- [ ] **Step 5: Browser verification**

Seed (active) items covering both paths for the current week: an `exam`/`quiz` with a `due_time` (→ grid block) and a `homework` (→ chip); plus one `done`. Reload → Schedule. Screenshot desktop + mobile. Confirm: chip on the due date, timed block at the right hour, done item dimmed/struck, tap opens detail, "+N more" still works with mixed academic+assignment days. Generate the week share image and confirm both render in it. Clean up seeds.

- [ ] **Step 6: Commit**

```bash
git add index.html
git commit -m "Assignments: Schedule rendering (chips + timed blocks + done dimming + share image)"
```

---

## Task 7: Import the 39 scraped Canvas items (one-time seed)

**Files:**
- Create: `scratchpad/import_canvas.js` (Node; not committed)
- Test: `scratchpad/test_decompose.js` (Node; not committed)

**Interfaces:**
- Consumes: `scratchpad/canvas_fall2026_aggregated.json`, `DB.enrollments` (for code→enrollment_id mapping).
- Produces: `pending`, `source='canvas'` rows in `carnelian.assignments`.

- [ ] **Step 1: Write `decomposeTitle` + its Node test**

`scratchpad/test_decompose.js` — implement and assert the decomposition used by the importer:
```js
function decomposeTitle(raw, kindHint){
  const s=String(raw||'').trim();
  let m;
  if(/^quiz\s*\d+/i.test(s)){ m=s.match(/quiz\s*(\d+)/i); return {kind:'quiz', number:+m[1]}; }
  if(/midterm/i.test(s)) return {kind:'exam', series:'Midterm Exam'};
  if(/final\s+exam/i.test(s)) return {kind:'exam', series:'Final Exam'};
  if(m=s.match(/^(writing case|speaking case)\s*(\d+)\s*:\s*(.+)$/i)) return {kind:'assignment', series:titleWords(m[1]), number:+m[2], descriptor:m[3]};
  if(m=s.match(/^homework\s*:\s*(.+)$/i)) return {kind:'homework', descriptor:m[1]};
  if(/survey$/i.test(s)) return {kind:'survey', override_title:s};
  if(/project/i.test(s)) return {kind:'project', override_title:s};
  return {kind:(kindHint||'assignment'), override_title:s};
}
```
Assert against representative scraped titles (Quiz 2; Midterm Exam; "Writing Case 3: Leasing Memo"; "Homework: Cover Letter Draft"; "Pre-Course Survey" → survey/override; "Optional Group Project Proposal due" → project/override). Run `node scratchpad/test_decompose.js` → ALL PASS. (`titleWords` = Title Case each word; reuse `asgTitleCase` logic.)

- [ ] **Step 2: Write the importer**

`scratchpad/import_canvas.js`: load `canvas_fall2026_aggregated.json`, for each course map `code`→`enrollment_id` (pass the enrollments in via a small JSON you fetch once through the app's `load`, or hard-code the code→id map after reading it). For each item produce a row: `{enrollment_id, name: <composed from decompose>, kind, series, number, descriptor, override_title, due_on: item.date, due_time: item.time||null, duration_min: (exam?75:quiz?30:null), status:'pending', source:'canvas'}`. Output either SQL `insert`s or a list of `upsert` payloads. For exam/quiz without a time, set `due_time` to the course meeting start (from `DB.enrollments[].meetings`) and leave a note.

- [ ] **Step 3: Map codes to enrollment ids**

Via app `load` (minted token) or Supabase `execute_sql`:
```sql
select id, code from carnelian.enrollments where code in ('REAL 6101','REAL 6640');
```
Fill the code→id map in the importer.

- [ ] **Step 4: Seed the rows**

Run the importer to emit rows, then insert them — preferred: Supabase `execute_sql` batch `insert into carnelian.assignments (...) values ...` (server-side, one call). Confirm count:
```sql
select enrollment_id, status, count(*) from carnelian.assignments group by 1,2 order by 1;
```
Expected: ~39 rows, all `status='pending'`, `source='canvas'` (9 for 6101's enrollment, 30 for 6640's).

- [ ] **Step 5: Verify in-app**

Reload the app → Planner shows "9 to review" / "30 to review" on those courses. Open one, spot-check a few composed titles look standardized, approve one and confirm it lands on the Schedule. Screenshot.

- [ ] **Step 6 (no commit):** importer + scraped data stay in scratchpad (personal data — never committed). The seeded rows live only in the user's DB.

---

## Self-review (completed)

- **Spec coverage:** entry point → Task 4; both-by-type rendering → Task 6; server-side storage → Tasks 1/3 (reuses generic CRUD); review queue → Task 5; composed+override naming → Task 2/4; done state → Tasks 4 (toggle) + 6 (dim); pre-load 39 → Task 7; out-of-scope Google layer → not built. Covered.
- **Placeholders:** none — composer/decompose/CRUD/helper code is complete; UI tasks give exact functions, ids, and integration points against verified line ranges.
- **Type consistency:** `composeAssignment`, `asgFor`, `asgWeek`, `asgTitle`, `KIND_TIMED`, `saveAsg`, `deleteAsg`, `approveAsg`, `pendingCount` names are consistent across tasks; row shape (`enrollment_id,name,kind,series,number,descriptor,override_title,due_on,due_time,duration_min,status,source,done`) matches the Task 1 allowlist exactly.
