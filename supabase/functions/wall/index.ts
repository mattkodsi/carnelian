import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import postgres from "https://deno.land/x/postgresjs@v3.4.5/mod.js";
import { ACAL_URL, parseAcademicCalendar } from "../_shared/acal.ts";
import { buildFeed, etToday } from "./feed.ts";

const ANON = Deno.env.get("SUPABASE_ANON_KEY")!;

const sql = postgres(Deno.env.get("SUPABASE_DB_URL")!, { prepare: false, ssl: "require", max: 4, idle_timeout: 20, connect_timeout: 15 });

// The registrar page changes a few times a term. Keep the last good parse in the
// database, refresh it at most daily, and keep serving it when a refresh fails
// (academicStatus.ok = false) so breaks never silently disappear.
async function academic(): Promise<{ events: any[]; ok: boolean; fetchedAt: string | null }> {
  let row: any = null;
  try { row = (await sql`select events, fetched_at from carnelian.academic_cache where id = 1`)[0] ?? null; } catch { /* no cache yet */ }
  const cachedAt = row ? new Date(row.fetched_at).toISOString() : null;
  if (row && Date.now() - Date.parse(cachedAt!) < 86400000) return { events: row.events, ok: true, fetchedAt: cachedAt };
  try {
    const ac = new AbortController();
    const to = setTimeout(() => ac.abort(), 8000);
    const res = await fetch(ACAL_URL, { headers: { "user-agent": "Mozilla/5.0 (Carnelian degree tracker)" }, signal: ac.signal });
    clearTimeout(to);
    if (!res.ok) throw new Error(`registrar returned ${res.status}`);
    const { events } = parseAcademicCalendar(await res.text());
    if (!events.length) throw new Error("registrar page had no dates");
    const fetchedAt = new Date().toISOString();
    try {
      await sql`insert into carnelian.academic_cache (id, events, fetched_at) values (1, ${sql.json(events)}, ${fetchedAt})
        on conflict (id) do update set events = excluded.events, fetched_at = excluded.fetched_at`;
    } catch { /* serve the fresh parse even if it can't be stored */ }
    return { events, ok: true, fetchedAt };
  } catch {
    return { events: row?.events ?? [], ok: false, fetchedAt: cachedAt };
  }
}

Deno.serve(async (req) => {
  const cors: Record<string, string> = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization,content-type,apikey", "Content-Type": "application/json" };
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const url = new URL(req.url);
  if (url.searchParams.get("key") !== ANON) return new Response(JSON.stringify({ ok: false, error: "unauthorized" }), { status: 401, headers: cors });

  try {
    const today = etToday(new Date());
    const [assignments, enrollments, terms, acad] = await Promise.all([
      sql`select id, name, override_title, series, number, descriptor, kind, due_on::text as due_on, due_time::text as due_time,
          duration_min::float8 as duration_min, target_on::text as target_on, target_time::text as target_time,
          status, source, canvas_url, enrollment_id
        from carnelian.assignments
        where done = false and canvas_removed_at is null
          and coalesce(status, '') not in ('cancelled', 'canceled', 'removed', 'deleted') and due_on >= ${today}`,
      sql`select id, code, title, meetings, term_id, status, role from carnelian.enrollments`,
      sql`select id, starts_on::text as starts_on, ends_on::text as ends_on from carnelian.terms`,
      academic(),
    ]);
    const feed = buildFeed({ now: new Date(), assignments, enrollments, terms, academic: acad });
    return new Response(JSON.stringify(feed), { headers: cors });
  } catch (e) {
    return new Response(JSON.stringify({ ok: false, error: String(e) }), { status: 500, headers: cors });
  }
});
