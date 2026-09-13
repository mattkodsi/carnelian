// Carnelian — Canvas .ics deadline sync (isolated from the main gateway so a
// deploy here can never disturb auth / data / Google-calendar sync).
// Fetches the user's tokenized Canvas calendar feed (no login — the URL token is
// the auth), parses VEVENTs, maps each to a course, and upserts into
// carnelian.assignments as pending review items. Idempotent via ext_uid; Canvas
// owns source state + the real deadline while Carnelian customizations remain.
import postgres from "https://deno.land/x/postgresjs@v3.4.5/mod.js";
import { parseVEvents, icalDateToET, normCode, courseKeys, guessKind, cleanSummary } from "./ical.ts";
import { reconcileCanvasSource, markCanvasMissing } from "./reconcile.ts";

const sql = postgres(Deno.env.get("SUPABASE_DB_URL")!, {
  prepare: false, ssl: "require", max: 3, idle_timeout: 20, connect_timeout: 15,
});

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type, authorization, apikey",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, status = 200) =>
  new Response(JSON.stringify(b), { status, headers: { ...CORS, "content-type": "application/json" } });

const enc = new TextEncoder();
async function sha256hex(s: string) {
  const d = await crypto.subtle.digest("SHA-256", enc.encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
// Session tokens live in carnelian.app_config.settings.sessions (sha256 hashes),
// the same store the main gateway uses.
async function authed(token: string | undefined) {
  if (!token) return false;
  const cfg = (await sql`select settings from carnelian.app_config where id = 1`)[0];
  const sessions: string[] = cfg?.settings?.sessions ?? [];
  return sessions.includes(await sha256hex(token));
}

const canvasCfg = async () => (await sql`select * from carnelian.canvas_config where id = 1`)[0] ?? {};
const normTitle = (s: string) => String(s || "").toLowerCase().replace(/[^a-z0-9]/g, "");

async function canvasSync() {
  const cfg = await canvasCfg();
  if (!cfg.feed_url) return { ok: false, error: "no feed configured" };
  let text: string;
  try {
    const ac = new AbortController();
    const to = setTimeout(() => ac.abort(), 10000);
    const res = await fetch(cfg.feed_url as string, { headers: { "user-agent": "Mozilla/5.0 (Carnelian degree tracker)" }, signal: ac.signal });
    clearTimeout(to);
    if (!res.ok) return { ok: false, error: `feed fetch failed (${res.status})` };
    text = await res.text();
  } catch (e) {
    return { ok: false, error: "feed not reachable: " + String((e as Error)?.message ?? e) };
  }
  const events = parseVEvents(text);

  // Courses in current/upcoming terms (for mapping) + their existing assignments (for reconcile).
  const enrolls = await sql`select e.id, e.code from carnelian.enrollments e
    left join carnelian.terms t on t.id = e.term_id
    where coalesce(e.status,'') <> 'wishlist' and (t.ends_on is null or t.ends_on >= current_date)`;
  const codeToEnr = new Map<string, number>();
  for (const e of enrolls as any[]) { const k = normCode(e.code); if (k && !codeToEnr.has(k)) codeToEnr.set(k, e.id); }
  const enrIds = (enrolls as any[]).map((e) => e.id);
  const existing = enrIds.length
    ? await sql`select id, enrollment_id, name, override_title, due_on::text as due_on, due_time::text as due_time,
        target_on::text as target_on, target_time::text as target_time, ext_uid, source,
        canvas_title, canvas_due_on::text as canvas_due_on, canvas_due_time::text as canvas_due_time,
        canvas_url, canvas_last_seen_at, canvas_removed_at, canvas_changed_at,
        canvas_missing_count, canvas_changes
      from carnelian.assignments where enrollment_id in ${sql(enrIds)}`
    : [];
  const rejected = new Set((await sql`select ext_uid from carnelian.canvas_rejections`).map((r: any) => r.ext_uid));
  const unassignedRows = await sql`select ext_uid, canvas_title, canvas_due_on::text as canvas_due_on,
    canvas_due_time::text as canvas_due_time, canvas_url, canvas_course_keys, canvas_last_seen_at,
    canvas_removed_at, canvas_changed_at, canvas_missing_count, canvas_changes
    from carnelian.canvas_unassigned`;
  const unassignedByUid = new Map((unassignedRows as any[]).map((r) => [r.ext_uid, r]));
  const byUid = new Map<string, any>();
  const scrapeByKey = new Map<string, any>(); // adopt a prior scrape (no ext_uid) instead of duplicating
  const nkey = (enr: number, due: string, name: string) => `${enr}|${due}|${normTitle(name)}`;
  for (const r of existing as any[]) {
    if (r.ext_uid) byUid.set(r.ext_uid, r);
    if (r.source === "canvas" && !r.ext_uid && r.due_on) scrapeByKey.set(nkey(r.enrollment_id, r.due_on, r.name), r);
  }

  const now = new Date().toISOString();
  const feedAssignments = events.filter((ev) => ev.uid && /assignment/i.test(ev.uid));
  const cancelledUids = new Set(feedAssignments.filter((ev) => ev.status === "CANCELLED").map((ev) => ev.uid));
  const feedAssignmentUids = new Set(feedAssignments.filter((ev) => ev.status !== "CANCELLED").map((ev) => ev.uid));
  const linkedInScope = (existing as any[]).filter((r) => r.source === "canvas" && r.ext_uid && !rejected.has(r.ext_uid));
  if (!feedAssignments.length && (linkedInScope.length || unassignedRows.length)) return { ok: false, error: "assignment feed was unexpectedly empty; existing links were preserved" };

  let added = 0, updated = 0, adopted = 0, filed = 0, unassigned = 0, skipped = 0, total = 0, missing = 0, removed = 0;
  for (const ev of events) {
    if (!ev.uid) continue;
    if (rejected.has(ev.uid)) { skipped++; continue; }
    // Only Canvas *assignments* are deadlines. The feed also carries calendar events
    // (office hours, career fairs) as event-calendar-event-* — skip those.
    if (!/assignment/i.test(ev.uid)) { skipped++; continue; }
    if (ev.status === "CANCELLED") { skipped++; continue; }
    const { due_on, due_time } = icalDateToET(ev.dtstart);
    if (!due_on) continue;
    total++;
    const title = cleanSummary(ev.summary) || "Untitled";
    // Map the source course when possible. An already-linked assignment remains
    // attached even if a malformed feed title temporarily drops its course tag.
    let mappedEnrId: number | null = null;
    const sourceKeys = [...new Set([...courseKeys(ev.summary), ...courseKeys(ev.description)])];
    for (const k of sourceKeys) { if (codeToEnr.has(k)) { mappedEnrId = codeToEnr.get(k)!; break; } }

    // 1) already ours (by uid): refresh Canvas-owned source state + real deadline.
    const own = byUid.get(ev.uid);
    if (own) {
      const patch = reconcileCanvasSource(own, {
        uid: ev.uid, enrollment_id: mappedEnrId ?? own.enrollment_id,
        title, due_on, due_time, url: ev.url || null,
      }, now);
      await sql`update carnelian.assignments set
        enrollment_id = ${patch.enrollment_id}, due_on = ${patch.due_on}, due_time = ${patch.due_time},
        canvas_title = ${patch.canvas_title}, canvas_due_on = ${patch.canvas_due_on}, canvas_due_time = ${patch.canvas_due_time},
        canvas_url = ${patch.canvas_url}, canvas_last_seen_at = ${patch.canvas_last_seen_at},
        canvas_removed_at = ${patch.canvas_removed_at}, canvas_missing_count = ${patch.canvas_missing_count},
        canvas_changes = ${sql.json(patch.canvas_changes)}, canvas_changed_at = ${patch.canvas_changed_at}
        where id = ${own.id}`;
      if (patch.source_changed) updated++;
      continue;
    }
    const inbox = unassignedByUid.get(ev.uid);
    if (mappedEnrId != null && inbox) {
      await sql.begin(async (tx) => {
        await tx`insert into carnelian.assignments (enrollment_id, name, override_title, kind, due_on, due_time, status, source, ext_uid, done,
          canvas_title, canvas_due_on, canvas_due_time, canvas_url, canvas_last_seen_at, canvas_missing_count, canvas_changes)
          values (${mappedEnrId}, ${title}, ${title}, ${guessKind(ev.summary)}, ${due_on}, ${due_time}, 'pending', 'canvas', ${ev.uid}, false,
            ${title}, ${due_on}, ${due_time}, ${ev.url || null}, ${now}, 0, '{}'::jsonb)
          on conflict (ext_uid) do nothing`;
        await tx`delete from carnelian.canvas_unassigned where ext_uid = ${ev.uid}`;
      });
      filed++; continue;
    }
    // map to a course — try every code in the (possibly cross-listed) tag, pick the
    // one the user is enrolled in; unmapped items are skipped + counted.
    const enrId = mappedEnrId;
    if (enrId == null) {
      if (inbox) {
        const patch = reconcileCanvasSource(inbox, { uid: ev.uid, enrollment_id: 0, title, due_on, due_time, url: ev.url || null }, now);
        await sql`update carnelian.canvas_unassigned set canvas_title = ${patch.canvas_title},
          canvas_due_on = ${patch.canvas_due_on}, canvas_due_time = ${patch.canvas_due_time}, canvas_url = ${patch.canvas_url},
          canvas_course_keys = ${sourceKeys}, canvas_last_seen_at = ${patch.canvas_last_seen_at},
          canvas_removed_at = ${patch.canvas_removed_at}, canvas_missing_count = ${patch.canvas_missing_count},
          canvas_changes = ${sql.json(patch.canvas_changes)}, canvas_changed_at = ${patch.canvas_changed_at}
          where ext_uid = ${ev.uid}`;
        if (patch.source_changed) updated++;
      } else {
        await sql`insert into carnelian.canvas_unassigned (ext_uid, canvas_title, canvas_due_on, canvas_due_time,
          canvas_url, canvas_course_keys, canvas_last_seen_at)
          values (${ev.uid}, ${title}, ${due_on}, ${due_time}, ${ev.url || null}, ${sourceKeys}, ${now})`;
      }
      unassigned++; continue;
    }
    // 2) adopt a prior scrape at the same course+date+title → stamp its ext_uid (no dup)
    const cand = scrapeByKey.get(nkey(enrId, due_on, title));
    if (cand) { await sql`update carnelian.assignments set ext_uid = ${ev.uid}, canvas_title = ${title},
      canvas_due_on = ${due_on}, canvas_due_time = ${due_time}, canvas_url = ${ev.url || null},
      canvas_last_seen_at = ${now}, canvas_missing_count = 0, canvas_changes = '{}'::jsonb
      where id = ${cand.id}`; byUid.set(ev.uid, { ...cand, ext_uid: ev.uid }); adopted++; continue; }
    // 3) insert a new pending item
    await sql`insert into carnelian.assignments (enrollment_id, name, override_title, kind, due_on, due_time, status, source, ext_uid, done,
      canvas_title, canvas_due_on, canvas_due_time, canvas_url, canvas_last_seen_at, canvas_missing_count, canvas_changes)
      values (${enrId}, ${title}, ${title}, ${guessKind(ev.summary)}, ${due_on}, ${due_time}, 'pending', 'canvas', ${ev.uid}, false,
        ${title}, ${due_on}, ${due_time}, ${ev.url || null}, ${now}, 0, '{}'::jsonb)`;
    added++;
  }

  // Reconcile existence only after a complete, healthy parse. Missing once is
  // tolerated; missing twice marks the linked source removed without deleting
  // the customized Carnelian assignment.
  for (const own of linkedInScope) {
    if (feedAssignmentUids.has(own.ext_uid)) continue;
    const patch = markCanvasMissing(own, now, cancelledUids.has(own.ext_uid)); missing++;
    if (!own.canvas_removed_at && patch.canvas_removed_at) removed++;
    await sql`update carnelian.assignments set canvas_missing_count = ${patch.canvas_missing_count},
      canvas_removed_at = ${patch.canvas_removed_at}, canvas_changes = ${sql.json(patch.canvas_changes)},
      canvas_changed_at = ${patch.canvas_changed_at} where id = ${own.id}`;
  }

  for (const own of unassignedRows as any[]) {
    if (rejected.has(own.ext_uid) || feedAssignmentUids.has(own.ext_uid)) continue;
    const patch = markCanvasMissing(own, now, cancelledUids.has(own.ext_uid)); missing++;
    if (!own.canvas_removed_at && patch.canvas_removed_at) removed++;
    await sql`update carnelian.canvas_unassigned set canvas_missing_count = ${patch.canvas_missing_count},
      canvas_removed_at = ${patch.canvas_removed_at}, canvas_changes = ${sql.json(patch.canvas_changes)},
      canvas_changed_at = ${patch.canvas_changed_at} where ext_uid = ${own.ext_uid}`;
  }

  const result = { added, updated, adopted, filed, unassigned, unmapped: 0, skipped, total, missing, removed };
  await sql`update carnelian.canvas_config set last_sync_at = now(), last_result = ${sql.json(result)}, updated_at = now() where id = 1`;
  return { ok: true, ...result };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  let body: any;
  try { body = await req.json(); } catch { return json({ error: "bad json" }, 400); }
  const action = body.action as string;
  try {
    // Nightly cron invokes canvas_sync with a shared secret (stored in the DB, read
    // by the pg_cron job) instead of a session token.
    if (action === "canvas_sync" && body.cron_secret) {
      const cc = await canvasCfg();
      if (cc.cron_secret && body.cron_secret === cc.cron_secret) return json(await canvasSync());
    }
    if (!(await authed(body.token))) return json({ error: "unauthorized" }, 401);
    if (action === "canvas_status") {
      const c = await canvasCfg();
      const pend = (await sql`select count(*)::int as n from carnelian.assignments where source = 'canvas' and status = 'pending'`)[0].n;
      const marked = (await sql`select count(*)::int as changed,
        count(*) filter (where canvas_removed_at is not null)::int as removed
        from carnelian.assignments where source = 'canvas' and canvas_changed_at is not null`)[0];
      const inbox = await sql`select ext_uid, canvas_title, canvas_due_on::text as canvas_due_on,
        canvas_due_time::text as canvas_due_time, canvas_url, canvas_course_keys,
        canvas_removed_at, canvas_changed_at, canvas_changes
        from carnelian.canvas_unassigned order by canvas_due_on, canvas_due_time, canvas_title`;
      return json({ ok: true, configured: !!c.feed_url, last_sync_at: c.last_sync_at ?? null,
        last_result: c.last_result ?? null, pending_canvas: pend,
        changed_canvas: marked.changed, removed_canvas: marked.removed,
        unassigned_canvas: inbox });
    }
    if (action === "canvas_sync") return json(await canvasSync());
    if (action === "canvas_ack") {
      const id = Number(body.id); if (!Number.isFinite(id)) return json({ error: "bad assignment" }, 400);
      const row = (await sql`update carnelian.assignments set canvas_changes = '{}'::jsonb, canvas_changed_at = null
        where id = ${id} and source = 'canvas' returning *`)[0];
      return row ? json({ ok: true, row }) : json({ error: "assignment not found" }, 404);
    }
    if (action === "canvas_keep") {
      const id = Number(body.id); if (!Number.isFinite(id)) return json({ error: "bad assignment" }, 400);
      const own = (await sql`select id, ext_uid from carnelian.assignments where id = ${id} and source = 'canvas'`)[0];
      if (!own) return json({ error: "assignment not found" }, 404);
      const row = await sql.begin(async (tx) => {
        if (own.ext_uid) await tx`insert into carnelian.canvas_rejections (ext_uid) values (${own.ext_uid}) on conflict do nothing`;
        return (await tx`update carnelian.assignments set source = 'manual', ext_uid = null,
          canvas_title = null, canvas_due_on = null, canvas_due_time = null, canvas_url = null,
          canvas_last_seen_at = null, canvas_removed_at = null, canvas_changed_at = null,
          canvas_missing_count = 0, canvas_changes = '{}'::jsonb where id = ${id} returning *`)[0];
      });
      return json({ ok: true, row });
    }
    if (action === "canvas_file") {
      const uid = String(body.ext_uid || ""), enrollmentId = Number(body.enrollment_id);
      if (!uid || !Number.isFinite(enrollmentId)) return json({ error: "bad assignment" }, 400);
      const enrollment = (await sql`select e.id from carnelian.enrollments e left join carnelian.terms t on t.id=e.term_id
        where e.id=${enrollmentId} and coalesce(e.status,'')<>'wishlist' and (t.ends_on is null or t.ends_on>=current_date)`)[0];
      const item = (await sql`select * from carnelian.canvas_unassigned where ext_uid=${uid}`)[0];
      if (!enrollment || !item) return json({ error: "assignment not found" }, 404);
      const row = await sql.begin(async (tx) => {
        const inserted = (await tx`insert into carnelian.assignments (enrollment_id, name, override_title, kind,
          due_on, due_time, status, source, ext_uid, done, canvas_title, canvas_due_on, canvas_due_time,
          canvas_url, canvas_last_seen_at, canvas_removed_at, canvas_changed_at, canvas_missing_count, canvas_changes)
          values (${enrollmentId}, ${item.canvas_title}, ${item.canvas_title}, ${guessKind(item.canvas_title)},
            ${item.canvas_due_on}, ${item.canvas_due_time}, 'pending', 'canvas', ${uid}, false,
            ${item.canvas_title}, ${item.canvas_due_on}, ${item.canvas_due_time}, ${item.canvas_url},
            ${item.canvas_last_seen_at}, ${item.canvas_removed_at}, ${item.canvas_changed_at},
            ${item.canvas_missing_count}, ${sql.json(item.canvas_changes || {})}) returning *`)[0];
        await tx`delete from carnelian.canvas_unassigned where ext_uid=${uid}`;
        return inserted;
      });
      return json({ ok: true, row });
    }
    if (action === "canvas_reject_unassigned") {
      const uid = String(body.ext_uid || ""); if (!uid) return json({ error: "bad assignment" }, 400);
      const found = (await sql`select ext_uid from carnelian.canvas_unassigned where ext_uid=${uid}`)[0];
      if (!found) return json({ error: "assignment not found" }, 404);
      await sql.begin(async (tx) => {
        await tx`insert into carnelian.canvas_rejections (ext_uid) values (${uid}) on conflict do nothing`;
        await tx`delete from carnelian.canvas_unassigned where ext_uid=${uid}`;
      });
      return json({ ok: true });
    }
    return json({ error: "unknown action" }, 400);
  } catch (err) {
    return json({ error: String((err as Error)?.message ?? err) }, 500);
  }
});
