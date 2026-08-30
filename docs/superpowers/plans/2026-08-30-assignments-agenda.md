# Assignments Agenda Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the Academic tab into a color-coded, date-ordered Assignments agenda; move the Cornell academic calendar to a Schedule-header button; color the Schedule Due-strip chips by course.

**Architecture:** Pure `index.html` client change over existing `DB.assignments` / `DB.enrollments` / `DB.terms`. No DB, edge-function, or cron changes. Reuses `courseColor`, `asgWhenDate/Time`, `asgTitle`, `asgTimeShort`, `approveAsg`/`rejectAsg`/`toggleAsgDone`, `openAsgEditor`, `paintAcademic`/`loadAcademic`, `openModal`/`closeModal`.

**Tech Stack:** Vanilla JS + template strings in a single static `index.html`; browser-preview verification (no unit-test harness for the UI — the only test suite is the Node iCal parser, untouched here).

## Global Constraints

- Copy is bare and factual — no marketing/casual filler (per user's hard rule).
- iPhone-first: verify at ~393px width; nothing may overflow horizontally.
- Dark + light theme must both hold (uses existing CSS vars: `--ink`, `--ink-2`, `--ink-3`, `--surface`, `--surface-2`, `--line`, `--line-strong`, `--accent`, `--accent-soft`, `--accent-line`).
- Course color mapping must match the Schedule's algorithm exactly: per current term, sequential `SCHED_COLORS[index]` in `DB.enrollments` order, keyed by `code` (fallback `'#'+id`), non-wishlist.
- Isolation: reuses the already-deployed `carnelian-canvas` sync path; no server touch.

---

### Task 1: Color the Due-strip chips by course

**Files:**
- Modify: `index.html:414-422` (`.adchip.asg` CSS), `index.html:1747` (chip HTML), `index.html:2865-2872` (share-PNG chip draw)

**Interfaces:**
- Consumes: `it.r.color` (course color, already computed in `asgWeek`).
- Produces: nothing new.

- [ ] **Step 1: CSS — replace the dot with a left accent bar.** In `.adchip.asg` (line 417) drop the `align-items:flex-start; gap:5px` dot layout and add a left bar. Replace lines 417-419 with:

```css
  .adchip.asg{color:var(--ink);background:var(--surface);border-color:var(--line-strong);border-left-width:3px;border-left-style:solid;padding-left:5px;white-space:normal}
  .adchip.asg .adchip-body{display:flex;flex-direction:column;min-width:0;line-height:1.25}
```

(The `border-left` color is set inline per-chip in Step 2. Keep `.adchip-t`, `.adchip-tm`, `.adchip.asg.done` rules as-is; delete the now-unused `.adchip.asg .asg-dot` rule at line 418.)

- [ ] **Step 2: HTML — set the bar color inline, remove the dot span.** At line 1747 change the asg branch from the `<span class="asg-dot">…` form to:

```js
      : `<div class="adchip asg${it.r.a.done?' done':''}" style="border-left-color:${it.r.color}"><span class="adchip-body"><span class="adchip-t">${esc(asgTitle(it.r.a))}</span>${it.r.time?`<span class="adchip-tm">${esc(asgTimeShort(it.r.time))}</span>`:''}</span></div>`).join("");
```

- [ ] **Step 3: Share PNG — draw a left bar instead of a dot.** At line 2868 replace the dot arc with a left bar and pull the text left. Change lines 2868 and 2870:

```js
          x.fillStyle=it.r.color; x.fillRect(bx, yy, 3, boxH);
```
```js
          it.lines.forEach((ln,li)=>x.fillText(ln, bx+boxPadX+4, yy+boxPadY+li*bandLH));
```

Also change the strike start (line 2871) from `bx+boxPadX+10` to `bx+boxPadX+4` (both the `moveTo` x and the width-clamp base), so a done item's strike matches the new text origin.

- [ ] **Step 4: Verify in browser.** Reload the Schedule tab in a week that has deadlines; confirm each Due chip shows a course-colored left bar (no dot), matching the course's block color, and that "+N more" / done chips still render. Screenshot.

- [ ] **Step 5: Commit.**

```bash
git add index.html && git commit -m "Schedule: color Due-strip chips by course (bar, not dot)"
```

---

### Task 2: Move the academic calendar to a Schedule-header sheet

**Files:**
- Modify: `index.html:795-801` (add `#acalSheet` modal next to `#acDayModal`), `index.html:1766` (add calendar button to `tools`), `index.html:1769` (wire it), `index.html:1903-1911` (`renderAcademic` — the phead/acal-body markup moves into the sheet body).

**Interfaces:**
- Consumes: `paintAcademic(data,scroll)` (`:1912`, targets `#acal-body`), `loadAcademic(force)` (`:1933`, targets `#acal-body` + `#acal-refresh`), `openModal`/`closeModal`.
- Produces: `openAcalSheet()` — opens the sheet and loads the calendar.

- [ ] **Step 1: Add the sheet markup.** After the `#acDayModal` block (line 801) insert:

```html
<!-- full academic calendar (opened from the Schedule) -->
<div class="modal" id="acalModal">
  <div class="sheet" style="max-width:440px">
    <div class="sh"><h3>Academic calendar</h3>
      <button class="x" id="acalClose" aria-label="Close">×</button></div>
    <div class="sb">
      <div class="ph-note" id="acal-note">Cornell University Registrar</div>
      <div id="acal-body"><div class="acal-load">Loading academic calendar…</div></div>
      <button class="btn" id="acal-refresh" style="margin-top:10px"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 11a8 8 0 1 0-.9 4.5"/><path d="M20 4v6h-6"/></svg>Refresh</button>
    </div>
  </div>
</div>
```

- [ ] **Step 2: Add `openAcalSheet` + close wiring.** Replace the body of `renderAcademic()` (lines 1903-1911) — see Task 3, which supersedes this function. For now add a standalone opener near `loadAcademic` (after line 1953):

```js
function openAcalSheet(){ const m=$("#acalModal"); if(!m) return;
  const rb=$("#acal-refresh"); if(rb) rb.onclick=()=>loadAcademic(true);
  const cb=$("#acalClose"); if(cb) cb.onclick=()=>closeModal(m);
  openModal(m); loadAcademic(false); }
```

- [ ] **Step 3: Add the calendar button to the Schedule tools.** At line 1766 add a third button before the closing `</div>`:

```js
  const tools=`<div class="shtools"><button id="schedImg" class="shbtn" aria-label="Share as image" title="Share this schedule as an image">${ICO.share}</button><button id="schedCal" class="shbtn${GCAL.connected?' on':''}" aria-label="Sync to Google Calendar" title="Sync to Google Calendar">${GCAL.connected?ICO.check:ICO.cal}</button><button id="schedAcal" class="shbtn" aria-label="Academic calendar" title="Cornell academic calendar"><svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3.5" y="5" width="17" height="15.5" rx="2.5"/><path d="M3.5 9.5h17M8 3v4M16 3v4"/><path d="M8 13h3M8 16.5h6"/></svg></button></div>`;
```

- [ ] **Step 4: Wire the button.** At line 1769 (the `schedImg`/`schedCal` wiring line) append:

```js
  { const ba=$("#schedAcal"); if(ba) ba.onclick=openAcalSheet; }
```

- [ ] **Step 5: Verify.** On the Schedule tab, tap the new calendar icon → the sheet opens, shows the registrar list (cached, then refreshed), Refresh works, close works. Screenshot.

- [ ] **Step 6: Commit.**

```bash
git add index.html && git commit -m "Schedule: academic calendar as a header button + sheet"
```

---

### Task 3: Assignments agenda in the Academic tab

**Files:**
- Modify: `index.html:643` (nav label + icon), `index.html:1080` (call `renderAssignments` in `renderAll`), `index.html:1903-1911` (replace `renderAcademic` with `renderAssignments`), `index.html:1528-1530` (re-render agenda after done/approve/reject), plus new CSS near the `.adchip`/asg block.

**Interfaces:**
- Consumes: `DB.assignments`, `DB.enrollments`, `DB.terms`, `currentTerm()`, `today()`, `courseColorIdx`, `SCHED_COLORS`, `codeLabel`, `asgTitle`, `asgWhenDate`, `asgWhenTime`, `asgTimeShort`, `asgById`, `approveAsg`, `rejectAsg`, `toggleAsgDone`, `openAsgEditor`, `canvasSyncNow`, `canvasRefresh`, `CANVAS`, `CUR`, `esc`, `$`.
- Produces: `renderAssignments()`, `agFocusTerm()`, `agColorMap()`.

- [ ] **Step 1: Relabel the nav item.** At line 643 change the label text from `Academic` to `Assignments` and swap the icon to a checklist. Replace the whole line:

```html
      <button class="navitem" data-nav="academic"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 6l1.2 1.2L7.5 4.8"/><path d="M4 12l1.2 1.2L7.5 10.8"/><path d="M4 18l1.2 1.2L7.5 16.8"/><path d="M11 6h9M11 12h9M11 18h9"/></svg>Assignments</button>
```

(Routing key `academic` and panel `#academic` stay — only the visible label/icon change.)

- [ ] **Step 2: Add agenda CSS.** Insert after the `.adchip.asg.done` rule (~line 422) a self-contained block:

```css
  /* Assignments agenda (Academic tab) */
  .agenda{padding:2px 0 90px}
  .ag-head{display:flex;align-items:center;justify-content:space-between;gap:10px;margin:2px 2px 2px}
  .ag-head h1{font-size:22px;font-weight:700;margin:0}
  .ag-sync{display:inline-flex;align-items:center;gap:6px;font-size:13px;font-weight:600;color:var(--ink-2);background:var(--surface);border:1px solid var(--line);border-radius:8px;padding:6px 11px}
  .ag-sync .ico{width:15px;height:15px}
  .ag-sync.spin .ico{animation:spin 1s linear infinite}
  .ag-count{font-size:12.5px;color:var(--ink-3);margin:0 2px 14px}
  .ag-sec{font-size:12px;font-weight:700;color:var(--ink-3);letter-spacing:.02em;margin:16px 2px 6px;display:flex;align-items:center;gap:6px}
  .ag-sec.overdue{color:var(--danger,#c2405b)}
  .ag-sec .ag-sec-d{color:var(--ink-3);font-weight:600}
  .ag-row{display:flex;gap:10px;align-items:flex-start;padding:9px 8px;border-top:.5px solid var(--line);border-left:3px solid var(--line);cursor:pointer}
  .ag-row:first-of-type{border-top:0}
  .ag-row.pending{background:color-mix(in srgb,var(--accent) 6%,transparent);cursor:default}
  .ag-row.over{background:color-mix(in srgb,var(--danger,#c2405b) 7%,transparent)}
  .ag-row.done{opacity:.5}
  .ag-main{flex:1;min-width:0}
  .ag-code{font-size:11px;font-weight:800;line-height:1.2}
  .ag-t{font-size:14px;color:var(--ink);line-height:1.3;overflow:hidden;text-overflow:ellipsis}
  .ag-row.done .ag-t{text-decoration:line-through}
  .ag-meta{font-size:11.5px;color:var(--ink-3);margin-top:1px}
  .ag-acts{display:flex;flex-direction:column;gap:5px;flex:0 0 auto}
  .ag-mini{font-size:12px;font-weight:700;border:1px solid var(--line);background:var(--surface);color:var(--ink-2);border-radius:7px;padding:3px 9px;white-space:nowrap}
  .ag-mini.ok{color:#1c8074;border-color:color-mix(in srgb,#1c8074 45%,var(--line))}
  .ag-mini.no{color:var(--ink-3)}
  .ag-check{width:26px;height:26px;flex:0 0 auto;border-radius:50%;border:2px solid var(--line-strong);background:var(--surface);color:#fff;display:flex;align-items:center;justify-content:center;padding:0}
  .ag-check.on{background:#3b7d4f;border-color:#3b7d4f}
  .ag-check .ico{width:15px;height:15px}
  .ag-empty{color:var(--ink-3);font-size:14px;text-align:center;padding:40px 16px}
```

(`--danger` may not exist in the palette — the `#c2405b` fallback covers that. Verify in Step 8 and, if `--danger` is undefined, the fallback already applies.)

- [ ] **Step 3: Replace `renderAcademic` with `renderAssignments` (data + render).** Replace lines 1903-1911 with the function below. Keep `paintAcademic`/`loadAcademic` (lines 1912-1953) and `openAcalSheet` (Task 2) untouched.

```js
// Focus term for the agenda: the term containing today, else the nearest upcoming term.
function agFocusTerm(){ const c=currentTerm(); if(c) return c; const t=today();
  return (DB.terms||[]).filter(x=>x.ends_on&&x.ends_on>=t).sort((a,b)=>String(a.starts_on).localeCompare(String(b.starts_on)))[0]||null; }
// Per-term color map matching renderSchedule's algorithm exactly (sequential, code-keyed, DB order).
function agColorMap(termId){ const m={}; let ci=0;
  (DB.enrollments||[]).filter(e=>e.term_id===termId&&displayStatus(e)!=="wishlist").forEach(e=>{ const k=e.code||('#'+e.id); if(m[k]==null){ m[k]=ci%SCHED_COLORS.length; ci++; } });
  return m; }
function agFmtSec(iso,today){ const p=iso.split("-"); const d=new Date(+p[0],+p[1]-1,+p[2]);
  const dow=["Sun","Mon","Tue","Wed","Thu","Fri","Sat"][d.getDay()];
  const md=`${ACAL_MONTHS[+p[1]-1]} ${+p[2]}`; const dd=Math.round((d-new Date(today.slice(0,4),+today.slice(5,7)-1,+today.slice(8,10)))/864e5);
  const lead=dd===0?"Today":dd===1?"Tomorrow":dow;
  return `<span>${lead}</span><span class="ag-sec-d">· ${md}</span>`; }
function renderAssignments(){
  const el=$("#academic"); if(!el) return;
  const term=agFocusTerm(); const t=today();
  const eids=new Set((DB.enrollments||[]).filter(e=>term&&e.term_id===term.id&&displayStatus(e)!=="wishlist").map(e=>String(e.id)));
  const enById=Object.fromEntries((DB.enrollments||[]).map(e=>[String(e.id),e]));
  const cmap=term?agColorMap(term.id):{};
  const colorOf=e=>SCHED_COLORS[(cmap[e.code||('#'+e.id)]??courseColorIdx(e.code))];
  const cidxOf=e=>(cmap[e.code||('#'+e.id)]??courseColorIdx(e.code));
  // in-scope items with a placement date; done-in-the-past drops off (done is done).
  const items=(DB.assignments||[]).filter(a=>eids.has(String(a.enrollment_id))).map(a=>{
    const en=enById[String(a.enrollment_id)]; const on=asgWhenDate(a);
    return {a,en,on,tm:asgWhenTime(a),over:on&&on<t&&!a.done,pending:a.status==='pending'}; })
    .filter(it=>it.on && (it.on>=t || (it.over&&it.pending) || it.over));
  const overdue=items.filter(it=>it.over).sort((x,y)=> x.on.localeCompare(y.on) || cidxOf(x.en)-cidxOf(y.en));
  const upcoming=items.filter(it=>!it.over);
  const byDay={}; upcoming.forEach(it=>{ (byDay[it.on]=byDay[it.on]||[]).push(it); });
  const days=Object.keys(byDay).sort();
  const nPend=items.filter(it=>it.pending).length, nUp=upcoming.filter(it=>!it.pending&&!it.a.done).length;
  const row=it=>{ const c=colorOf(it.en); const code=esc(codeLabel(it.en)); const title=esc(asgTitle(it.a));
    const meta=(it.tm?esc(asgTimeShort(it.tm)):'')+(it.pending?(it.tm?' · ':'')+'from Canvas':'');
    if(it.pending) return `<div class="ag-row pending${it.over?' over':''}" style="border-left-color:${c}"><div class="ag-main"><div class="ag-code" style="color:${c}">${code}</div><div class="ag-t">${title}</div>${meta?`<div class="ag-meta">${meta}</div>`:''}</div><div class="ag-acts"><button class="ag-mini ok" data-approve="${it.a.id}">Accept</button><button class="ag-mini no" data-reject="${it.a.id}">Reject</button><button class="ag-mini" data-edit="${it.a.id}">Edit</button></div></div>`;
    return `<div class="ag-row${it.a.done?' done':''}${it.over?' over':''}" data-open="${it.a.id}" style="border-left-color:${c}"><div class="ag-main"><div class="ag-code" style="color:${c}">${code}</div><div class="ag-t">${title}</div>${meta?`<div class="ag-meta">${meta}</div>`:''}</div><button class="ag-check${it.a.done?' on':''}" data-done="${it.a.id}" aria-label="Toggle done">${it.a.done?ICO.check:''}</button></div>`; };
  let html=`<div class="agenda"><div class="ag-head"><h1>Assignments</h1><button class="ag-sync" id="agSync"><svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 11a8 8 0 1 0-.9 4.5"/><path d="M20 4v6h-6"/></svg>Sync</button></div>`;
  html+=`<div class="ag-count">${nPend?`${nPend} from Canvas to review · `:''}${nUp} upcoming</div>`;
  if(!items.length){ html+=`<div class="ag-empty">No assignments this term. Add them per course in the Planner, or use Sync to pull from Canvas.</div></div>`; el.innerHTML=html; wireAgenda(el); return; }
  if(overdue.length){ html+=`<div class="ag-sec overdue"><svg class="ico" style="width:13px;height:13px" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M12 8v5M12 16.5v.01"/><path d="M10.3 3.9 2.5 18a2 2 0 0 0 1.7 3h15.6a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/></svg>Overdue</div>`;
    html+=overdue.map(row).join(""); }
  days.forEach(d=>{ html+=`<div class="ag-sec">${agFmtSec(d,t)}</div>`+byDay[d].sort((x,y)=> cidxOf(x.en)-cidxOf(y.en) || String(x.tm||'~').localeCompare(String(y.tm||'~'))).map(row).join(""); });
  html+=`</div>`;
  el.innerHTML=html; wireAgenda(el);
}
function wireAgenda(el){
  const sb=$("#agSync"); if(sb) sb.onclick=async()=>{ sb.classList.add('spin'); sb.disabled=true;
    try{ const msg=await canvasSyncNow(); if(msg) toast(msg); await canvasRefresh(); }catch(e){ toast(e.message||"Sync failed"); }
    finally{ sb.classList.remove('spin'); sb.disabled=false; if(CUR==='academic') renderAssignments(); } };
  el.querySelectorAll("[data-approve]").forEach(b=>b.onclick=()=>{ const a=asgById(b.dataset.approve); if(a) approveAsg(a); });
  el.querySelectorAll("[data-reject]").forEach(b=>b.onclick=()=>{ const a=asgById(b.dataset.reject); if(a) rejectAsg(a); });
  el.querySelectorAll("[data-edit]").forEach(b=>b.onclick=()=>{ const a=asgById(b.dataset.edit); if(a) openAsgEditor(a.enrollment_id,a); });
  el.querySelectorAll("[data-done]").forEach(b=>b.onclick=(e)=>{ e.stopPropagation(); const a=asgById(b.dataset.done); if(a) toggleAsgDone(a); });
  el.querySelectorAll("[data-open]").forEach(r=>r.onclick=()=>{ const a=asgById(r.dataset.open); if(a) openAsgEditor(a.enrollment_id,a); });
}
```

- [ ] **Step 4: Update the `renderAll` call site.** At line 1080 change `renderAcademic()` to `renderAssignments()`:

```js
function renderAll(){ renderRail(); renderDashboard(); renderRequirements(); renderPlanner(); renderTranscript(); renderAssignments(); renderSchedule(); showPage(CUR); }
```

- [ ] **Step 5: Re-render the agenda after done/approve/reject.** So mutations from the agenda (and from the Planner) keep it fresh. Edit lines 1528-1530:

```js
async function toggleAsgDone(a){ try{ await saveAsg({id:a.id, done:!a.done}); renderAsgList(a.enrollment_id); if(CUR==='academic')renderAssignments(); }catch(e){ toast(e.message||"Error"); } }
async function approveAsg(a){ try{ await saveAsg({id:a.id, status:'active'}); renderAsgList(a.enrollment_id); if(CUR==='planner')renderPlanner(); if(CUR==='academic')renderAssignments(); }catch(e){ toast(e.message||"Error"); } }
async function rejectAsg(a){ try{ await deleteAsg(a.id); renderAsgList(a.enrollment_id); if(CUR==='planner')renderPlanner(); if(CUR==='academic')renderAssignments(); }catch(e){ toast(e.message||"Error"); } }
```

(`renderAsgList` targets `#asgListBody`, which only exists when the course sheet is open — it no-ops otherwise, so calling it from the agenda is harmless.)

- [ ] **Step 6: Confirm `canvasSyncNow` returns a message.** Check the definition (~line 823 region) — it was built with `opts.silent`; called with no args it should toast/return a status string. If it needs `{}`, the `wireAgenda` call already passes none; adjust the call to `canvasSyncNow({})` only if the signature requires it. Read the function before running.

- [ ] **Step 7: Verify the agenda in the browser.** Open the Assignments tab (auth-token flow on a local `http.server`). Confirm: title + Sync + count line; Overdue section pinned if any; day sections labeled `Today · …` / `Mon · …`, empty days skipped; rows show a course-colored left bar + colored code + title + time; Canvas pending rows have Accept/Reject/Edit and a tinted background; active rows have a done-circle; tapping a row opens the editor; Accept/Reject/done mutate and the list re-renders. Screenshot.

- [ ] **Step 8: Verify colors match the Schedule + both themes.** Cross-check that a course's agenda color equals its Schedule block color. Toggle dark/light (`resize_window` colorScheme) — confirm the overdue tint, pending tint, and code colors hold. Confirm no horizontal overflow at 393px.

- [ ] **Step 9: Commit.**

```bash
git add index.html && git commit -m "Academic tab: color-coded Assignments agenda (was calendar)"
```

---

## Self-Review

**Spec coverage:**
- Part 1 (color Due chips) → Task 1 (live + PNG). ✓
- Part 2 (agenda: this-term-forward, overdue pinned, day sections skip-empty, sort by color, rows 3-way colored, Canvas Accept/Reject, active done-check, done dimmed in place, header + count, empty state) → Task 3. ✓
- Part 3 (calendar → Schedule button/sheet, inline chips unchanged) → Task 2. ✓
- Nav relabel Academic→Assignments → Task 3 Step 1. ✓
- Re-render wiring → Task 3 Step 5. ✓

**Placeholder scan:** none — every step has literal code. Step 6 is a read-then-confirm on an existing function, not a placeholder.

**Type consistency:** `renderAssignments`, `agFocusTerm`, `agColorMap`, `agFmtSec`, `wireAgenda` are defined in Task 3 and referenced consistently (renderAll, mutation hooks). `openAcalSheet` defined in Task 2, wired in Task 2 Step 4. `colorOf`/`cidxOf` local to `renderAssignments`. Course-color algorithm matches `renderSchedule` (`:1644`) exactly.
