// Carnelian — Canvas .ics deadline sync (isolated from the main gateway so a
// deploy here can never disturb auth / data / Google-calendar sync).
// Fetches the user's tokenized Canvas calendar feed (no login — the URL token is
// the auth), parses VEVENTs, maps each to a course, and upserts into
// carnelian.assignments as pending review items. Idempotent via ext_uid; never
// overwrites user edits, never auto-deletes.
import postgres from "https://deno.land/x/postgresjs@v3.4.5/mod.js";
import { parseVEvents, icalDateToET, normCode, courseKey, guessKind, cleanSummary } from "./ical.ts";

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

const p2 = (n: number) => String(n).padStart(2, "0");
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
    ? await sql`select id, enrollment_id, name, due_on::text as due_on, ext_uid, source from carnelian.assignments where enrollment_id in ${sql(enrIds)}`
    : [];
  const byUid = new Map<string, any>();
  const scrapeByKey = new Map<string, any>(); // adopt a prior scrape (no ext_uid) instead of duplicating
  const nkey = (enr: number, due: string, name: string) => `${enr}|${due}|${normTitle(name)}`;
  for (const r of existing as any[]) {
    if (r.ext_uid) byUid.set(r.ext_uid, r);
    if (r.source === "canvas" && !r.ext_uid && r.due_on) scrapeByKey.set(nkey(r.enrollment_id, r.due_on, r.name), r);
  }

  const c = new Date(); c.setDate(c.getDate() - 7);
  const cutoff = `${c.getFullYear()}-${p2(c.getMonth() + 1)}-${p2(c.getDate())}`;

  let added = 0, updated = 0, adopted = 0, unmapped = 0, total = 0;
  for (const ev of events) {
    if (!ev.uid) continue;
    const { due_on, due_time } = icalDateToET(ev.dtstart);
    if (!due_on || due_on < cutoff) continue;
    total++;
    // 1) already ours (by uid): only refresh the date/time, never user edits
    const own = byUid.get(ev.uid);
    if (own) {
      if (own.due_on !== due_on) { await sql`update carnelian.assignments set due_on = ${due_on}, due_time = ${due_time} where id = ${own.id}`; updated++; }
      continue;
    }
    // map to a course; unmapped events are skipped + counted (they re-appear next sync once mapped)
    const ck = courseKey(ev.summary) || courseKey(ev.description);
    const enrId = ck ? (codeToEnr.get(ck) ?? null) : null;
    if (enrId == null) { unmapped++; continue; }
    const title = cleanSummary(ev.summary) || "Untitled";
    // 2) adopt a prior scrape at the same course+date+title → stamp its ext_uid (no dup)
    const cand = scrapeByKey.get(nkey(enrId, due_on, title));
    if (cand) { await sql`update carnelian.assignments set ext_uid = ${ev.uid} where id = ${cand.id}`; byUid.set(ev.uid, { ...cand, ext_uid: ev.uid }); adopted++; continue; }
    // 3) insert a new pending item
    await sql`insert into carnelian.assignments (enrollment_id, name, override_title, kind, due_on, due_time, status, source, ext_uid, done)
      values (${enrId}, ${title}, ${title}, ${guessKind(ev.summary)}, ${due_on}, ${due_time}, 'pending', 'canvas', ${ev.uid}, false)`;
    added++;
  }
  const result = { added, updated, adopted, unmapped, total };
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
      return json({ ok: true, configured: !!c.feed_url, last_sync_at: c.last_sync_at ?? null, last_result: c.last_result ?? null, pending_canvas: pend });
    }
    if (action === "canvas_sync") return json(await canvasSync());
    return json({ error: "unknown action" }, 400);
  } catch (err) {
    return json({ error: String((err as Error)?.message ?? err) }, 500);
  }
});
