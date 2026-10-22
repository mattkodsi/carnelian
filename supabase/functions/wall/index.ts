import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import postgres from "https://deno.land/x/postgresjs@v3.4.5/mod.js";

const TZ = "America/New_York";
const ANON = Deno.env.get("SUPABASE_ANON_KEY")!;
const DOW: Record<string, number> = { U: 0, M: 1, T: 2, W: 3, R: 4, F: 5, S: 6 };

const sql = postgres(Deno.env.get("SUPABASE_DB_URL")!, { prepare: false, ssl: "require", max: 4, idle_timeout: 20, connect_timeout: 15 });

const BLDG: [RegExp, [number, number]][] = [
  [/sibley/i, [42.4513, -76.4842]], [/olin\s*hall/i, [42.4446, -76.4839]],
  [/statler/i, [42.4459, -76.4822]], [/phillips/i, [42.4447, -76.4818]],
  [/uris\s*hall/i, [42.4483, -76.4826]], [/white\s*hall/i, [42.4497, -76.4841]],
  [/brz|breazzano|bartels/i, [42.4456, -76.4786]], [/warren/i, [42.4487, -76.4778]],
  [/myron\s*taylor/i, [42.4443, -76.4835]], [/mann/i, [42.4489, -76.4761]],
  [/goldwin/i, [42.4494, -76.4835]], [/klarman/i, [42.4494, -76.4830]],
];
function coordsFor(loc: string | null) {
  if (!loc) return null;
  for (const [re, c] of BLDG) if (re.test(loc)) return { lat: c[0], lng: c[1] };
  return null;
}
function tzOffsetMs(utcMs: number): number {
  const p = new Intl.DateTimeFormat("en-US", { timeZone: TZ, hour12: false, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }).formatToParts(new Date(utcMs));
  const g = (t: string) => +p.find((x) => x.type === t)!.value;
  const asIf = Date.UTC(g("year"), g("month") - 1, g("day"), g("hour") % 24, g("minute"), g("second"));
  return asIf - utcMs;
}
function etToISO(y: number, mo: number, d: number, h: number, mi: number): string {
  const guess = Date.UTC(y, mo - 1, d, h, mi);
  const off = tzOffsetMs(guess);
  let utc = guess - off;
  const off2 = tzOffsetMs(utc);
  if (off2 !== off) utc = guess - off2;
  return new Date(utc).toISOString();
}
function etParts(instant: Date) {
  const p = new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(instant);
  const g = (t: string) => p.find((x) => x.type === t)!.value;
  const y = +g("year"), mo = +g("month"), d = +g("day");
  return { y, mo, d, iso: `${g("year")}-${g("month")}-${g("day")}`, dow: new Date(Date.UTC(y, mo - 1, d)).getUTCDay() };
}
function isoFromDue(dateStr: string, timeStr: string | null): string {
  const [y, mo, d] = dateStr.split("-").map(Number);
  const [h, mi] = (timeStr || "23:59").split(":").map(Number);
  return etToISO(y, mo, d, h, mi);
}

// Verified section dates: https://classes.cornell.edu/browse/roster/FA26/class/INDO/1100
// Kept independently of enrollment edits, which can omit meeting date metadata.
function meetingDates(e, m, t) {
  const known = e.code === "INDO 1100" && m.section === "001" &&
    t.starts_on === "2026-08-24" && t.ends_on === "2026-12-18"
    ? {start:"2026-10-14",end:"2026-12-04"} : {};
  const iso = value => /^\d{4}-\d{2}-\d{2}$/.test(value || "") ? value : null;
  return {start:iso(m.startDate)||iso(m.sd)||known.start, end:iso(m.endDate)||iso(m.ed)||known.end};
}

Deno.serve(async (req) => {
  const cors: Record<string, string> = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization,content-type,apikey", "Content-Type": "application/json" };
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const url = new URL(req.url);
  if (url.searchParams.get("key") !== ANON) return new Response(JSON.stringify({ ok: false, error: "unauthorized" }), { status: 401, headers: cors });

  try {
    const today = etParts(new Date()).iso;
    const [asg, enr, terms] = await Promise.all([
      sql`select id, coalesce(nullif(override_title,''), name) as title, kind, due_on::text as due_on, due_time::text as due_time, status, enrollment_id from carnelian.assignments where done = false and canvas_removed_at is null and coalesce(status, '') not in ('cancelled', 'canceled', 'removed', 'deleted') and due_on >= ${today} order by due_on asc, due_time asc nulls last limit 60`,
      sql`select id, code, title, meetings, term_id from carnelian.enrollments`,
      sql`select id, starts_on::text as starts_on, ends_on::text as ends_on from carnelian.terms`,
    ]);
    const codeById = new Map(enr.map((e: any) => [e.id, e.code]));
    const termById = new Map(terms.map((t: any) => [t.id, t]));

    const deadlines = asg.map((a: any) => ({
      id: a.id, title: (a.title || "Untitled").trim(), course: codeById.get(a.enrollment_id) || null,
      kind: a.kind, status: a.status, allDay: !a.due_time, dueISO: isoFromDue(a.due_on, a.due_time),
    }));
    const exams = deadlines.filter((d: any) => d.kind === "exam");

    const events: any[] = [];
    for (let i = 0; i < 8; i++) {
      const ep = etParts(new Date(Date.now() + i * 86400000));
      for (const e of enr) {
        const t: any = termById.get(e.term_id);
        if (!t || !t.starts_on || !t.ends_on) continue;
        if (ep.iso < t.starts_on || ep.iso > t.ends_on) continue;
        const mid = new Date((Date.parse(t.starts_on) + Date.parse(t.ends_on)) / 2).toISOString().slice(0, 10);
        for (const m of (e.meetings || [])) {
          if (!m.days || !m.days.length || !m.start || !m.end) continue;
          if (!m.days.some((dd: string) => DOW[dd] === ep.dow)) continue;
          // Explicit roster dates take precedence over legacy half-term estimates.
          const dates = meetingDates(e,m,t);
          if (dates.start && ep.iso < dates.start) continue;
          if (dates.end && ep.iso > dates.end) continue;
          if (!dates.end && m.part === "1" && ep.iso > mid) continue;
          if (!dates.start && m.part === "2" && ep.iso < mid) continue;
          const [sh, sm] = m.start.split(":").map(Number), [eh, em] = m.end.split(":").map(Number);
          events.push({
            title: e.code ? `${e.code} · ${e.title}` : e.title, code: e.code,
            location: m.location || null, component: m.component || null, dest: coordsFor(m.location),
            startISO: etToISO(ep.y, ep.mo, ep.d, sh, sm), endISO: etToISO(ep.y, ep.mo, ep.d, eh, em),
          });
        }
      }
    }
    events.sort((a, b) => (a.startISO < b.startISO ? -1 : 1));

    return new Response(JSON.stringify({ ok: true, generatedAt: new Date().toISOString(), tz: TZ, counts: { deadlines: deadlines.length, exams: exams.length, events: events.length }, deadlines, exams, events }), { headers: cors });
  } catch (e) {
    return new Response(JSON.stringify({ ok: false, error: String(e) }), { status: 500, headers: cors });
  }
});
