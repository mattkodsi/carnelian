// Carnelian — passcode-gated data gateway.
// Runs inside Supabase; talks to the private `carnelian` schema over the
// function's own DB connection (SUPABASE_DB_URL). No Supabase keys or secrets
// ever reach the public site — the browser sends only a passcode/session token.
// Also brokers Google Calendar sync: the OAuth client secret + the user's
// refresh/access tokens live only here (env + locked carnelian tables), never
// in the browser.
import postgres from "https://deno.land/x/postgresjs@v3.4.5/mod.js";

// Connection hygiene: this is a single-user app, so keep the per-isolate pool tiny and let idle
// connections close quickly. Without idle_timeout, postgres.js holds up to `max` (default 10)
// connections open indefinitely per warm isolate — a burst of requests then piles up idle
// connections and can exhaust the DB's non-superuser slots ("remaining connection slots are
// reserved for roles with the SUPERUSER attribute"). max + idle_timeout make bursts drain.
const sql = postgres(Deno.env.get("SUPABASE_DB_URL")!, {
  prepare: false,
  ssl: "require",
  max: 4,               // cap connections per isolate
  idle_timeout: 20,     // close a connection 20s after it goes idle
  connect_timeout: 15,  // fail fast instead of hanging if the pool is momentarily saturated
});

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type, authorization, apikey",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, status = 200) =>
  new Response(JSON.stringify(b), { status, headers: { ...CORS, "content-type": "application/json" } });

// ---------- Google Calendar config ----------
// Client id is public (it rides in the consent URL); secret must be an env var.
const GOOGLE_CLIENT_ID = Deno.env.get("GOOGLE_CLIENT_ID") ??
  "535989985660-63is9a5ka5vc2br3tvv5ifutcp7dqh2b.apps.googleusercontent.com";
const GOOGLE_CLIENT_SECRET = Deno.env.get("GOOGLE_CLIENT_SECRET") ?? "";
const REDIRECT_URI = "https://uhwdnmbxiopfysodydty.supabase.co/functions/v1/carnelian";
const APP_URL = "https://mattkodsi.github.io/carnelian/";
const GCAL_SCOPES = "https://www.googleapis.com/auth/calendar openid email";
const TZ = "America/New_York";

// ---------- crypto (Web Crypto only, no deps) ----------
const enc = new TextEncoder();
const b64 = (buf: ArrayBuffer | Uint8Array) =>
  btoa(String.fromCharCode(...new Uint8Array(buf as ArrayBuffer)));
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

async function pbkdf2(passcode: string, salt: Uint8Array, iterations: number) {
  const key = await crypto.subtle.importKey("raw", enc.encode(passcode), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", salt, iterations, hash: "SHA-256" }, key, 256);
  return new Uint8Array(bits);
}
async function hashPasscode(passcode: string) {
  const iterations = 150000;
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const h = await pbkdf2(passcode, salt, iterations);
  return `pbkdf2$${iterations}$${b64(salt)}$${b64(h)}`;
}
async function verifyPasscode(passcode: string, stored: string) {
  try {
    const [alg, iterS, saltS, hashS] = stored.split("$");
    if (alg !== "pbkdf2") return false;
    const h = await pbkdf2(passcode, unb64(saltS), parseInt(iterS));
    const want = unb64(hashS);
    if (h.length !== want.length) return false;
    let diff = 0;
    for (let i = 0; i < h.length; i++) diff |= h[i] ^ want[i];
    return diff === 0;
  } catch {
    return false;
  }
}
async function sha256hex(s: string) {
  const d = await crypto.subtle.digest("SHA-256", enc.encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
const newToken = () => b64(crypto.getRandomValues(new Uint8Array(32))).replace(/[^a-zA-Z0-9]/g, "").slice(0, 40);

// ---------- config / sessions ----------
const getConfig = async () => (await sql`select * from carnelian.app_config where id = 1`)[0];

async function addSession(token: string) {
  const cfg = await getConfig();
  const sessions: string[] = cfg.settings?.sessions ?? [];
  const th = await sha256hex(token);
  const next = [th, ...sessions.filter((x) => x !== th)].slice(0, 8);
  const settings = { ...(cfg.settings ?? {}), sessions: next };
  await sql`update carnelian.app_config set settings = ${sql.json(settings)}, updated_at = now() where id = 1`;
}
async function authed(token: string | undefined) {
  if (!token) return false;
  const cfg = await getConfig();
  const sessions: string[] = cfg.settings?.sessions ?? [];
  return sessions.includes(await sha256hex(token));
}

// ---------- generic upsert/delete for allow-listed tables ----------
const COLS: Record<string, string[]> = {
  enrollments: ["code", "title", "credits", "term_id", "status", "grade", "gpa_points", "counts_gpa", "pinned_requirement_id", "tags", "offered_terms", "notes", "analog_of", "in_as", "meetings", "role"],
  terms: ["id", "name", "career", "kind", "starts_on", "ends_on", "sort"],
  adjustments: ["program_id", "type", "from_requirement_id", "to_requirement_id", "satisfies_requirement_id", "credits", "trigger_course", "note"],
  assignments: ["enrollment_id", "name", "kind", "series", "number", "descriptor", "override_title", "due_on", "due_time", "duration_min", "target_on", "target_time", "status", "source", "done", "weight", "score", "sort"],
  satisfactions: ["enrollment_id", "requirement_id", "note"],
  requirements: ["id", "program_id", "parent_id", "name", "kind", "credits_required", "count_required", "attribute_tag", "sort", "notes", "spec"],
  programs: ["id", "name", "kind", "status", "sort"],
};

const TEXT_ID = new Set(["terms", "requirements", "programs"]);

async function upsert(table: string, row: Record<string, unknown>) {
  const allow = COLS[table];
  if (!allow) throw new Error("table not allowed");
  // Only write fields the caller actually provided, so DB defaults apply on insert
  // and partial updates only touch what changed.
  const cols = allow.filter((c) => row[c] !== undefined);
  const vals: Record<string, unknown> = {};
  for (const c of cols) vals[c] = row[c];

  if (TEXT_ID.has(table)) {
    if (!row.id) throw new Error(table + " requires id");
    const upd = cols.filter((c) => c !== "id");
    const r = await sql`insert into carnelian.${sql(table)} ${sql(vals, ...cols)}
      on conflict (id) do update set ${sql(vals, ...upd)} returning *`;
    return r[0];
  }
  if (row.id) {
    const setCols = cols.filter((c) => c !== "id");
    if (setCols.length === 0) return (await sql`select * from carnelian.${sql(table)} where id = ${row.id as number}`)[0];
    const r = await sql`update carnelian.${sql(table)} set ${sql(vals, ...setCols)}${
      table === "enrollments" ? sql`, updated_at = now()` : sql``
    } where id = ${row.id as number} returning *`;
    return r[0];
  }
  const r = await sql`insert into carnelian.${sql(table)} ${sql(vals, ...cols)} returning *`;
  return r[0];
}

// ================= Google Calendar sync =================
const gcalCfg = async () => (await sql`select * from carnelian.gcal_config where id = 1`)[0] ?? {};

// Exchange the one-time authorization code for tokens; keep the refresh token.
async function exchangeCode(code: string) {
  const body = new URLSearchParams({
    code, client_id: GOOGLE_CLIENT_ID, client_secret: GOOGLE_CLIENT_SECRET,
    redirect_uri: REDIRECT_URI, grant_type: "authorization_code",
  });
  const r = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body,
  });
  const j = await r.json();
  if (!j.access_token) throw new Error(j.error_description || j.error || "token exchange failed");
  let email: string | null = null;
  if (j.id_token) {
    try {
      const p = JSON.parse(atob(String(j.id_token).split(".")[1].replace(/-/g, "+").replace(/_/g, "/")));
      email = p.email ?? null;
    } catch { /* ignore */ }
  }
  const exp = new Date(Date.now() + (j.expires_in || 3500) * 1000).toISOString();
  await sql`update carnelian.gcal_config set
    refresh_token = coalesce(${j.refresh_token ?? null}, refresh_token),
    access_token = ${j.access_token}, access_expiry = ${exp},
    email = coalesce(${email}, email), connected_at = now(),
    oauth_state = null, oauth_state_at = null where id = 1`;
}

// Return a valid access token, refreshing (and caching) when needed.
async function accessToken() {
  const cfg = await gcalCfg();
  if (!cfg.refresh_token) throw { reauth: true };
  if (cfg.access_token && cfg.access_expiry && new Date(cfg.access_expiry).getTime() > Date.now() + 60000) {
    return cfg.access_token as string;
  }
  const body = new URLSearchParams({
    client_id: GOOGLE_CLIENT_ID, client_secret: GOOGLE_CLIENT_SECRET,
    refresh_token: cfg.refresh_token, grant_type: "refresh_token",
  });
  const r = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body,
  });
  const j = await r.json();
  if (!j.access_token) {
    if (j.error === "invalid_grant") {
      await sql`update carnelian.gcal_config set refresh_token = null, access_token = null where id = 1`;
      throw { reauth: true };
    }
    throw new Error(j.error_description || j.error || "token refresh failed");
  }
  const exp = new Date(Date.now() + (j.expires_in || 3500) * 1000).toISOString();
  await sql`update carnelian.gcal_config set access_token = ${j.access_token}, access_expiry = ${exp} where id = 1`;
  return j.access_token as string;
}

async function gapi(access: string, method: string, path: string, body?: unknown) {
  const r = await fetch("https://www.googleapis.com/calendar/v3" + path, {
    method,
    headers: { authorization: `Bearer ${access}`, "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (r.status === 401) throw { reauth: true };
  const t = await r.text();
  let j: any = {}; try { j = t ? JSON.parse(t) : {}; } catch { /* ignore */ }
  return { status: r.status, j };
}

async function ensureCalendar(access: string) {
  const cfg = await gcalCfg();
  if (cfg.calendar_id) return cfg.calendar_id as string;
  const { status, j } = await gapi(access, "POST", "/calendars", { summary: "Carnelian", timeZone: TZ });
  if (status >= 300 || !j.id) throw new Error("could not create calendar");
  await sql`update carnelian.gcal_config set calendar_id = ${j.id} where id = 1`;
  return j.id as string;
}

// ---- event building (recurrence, half-term windows) ----
const DOW: Record<string, number> = { M: 1, T: 2, W: 3, R: 4, F: 5, S: 6, U: 0 };
const BYDAY: Record<string, string> = { M: "MO", T: "TU", W: "WE", R: "TH", F: "FR", S: "SA", U: "SU" };
// App schedule palette (MUST match index.html SCHED_COLORS) → nearest Google Calendar event colorId
// (by hue) so Google events are colour-matched to the app's weekly grid. Index 11 is the desaturated
// blue-grey used for TA/no-credit roles → routed to Graphite. Specific courses are pinned (COURSE_PIN,
// mirroring the app) so HADM 6205 shows grey, Management Communication shows red, etc. on Google too.
const SCHED_COLORS = ["#1971C2", "#E8590C", "#099268", "#C2255C", "#2B8A3E", "#7048E8", "#1098AD", "#E03131", "#9C36B5", "#4263EB", "#A0522D", "#64748B"];
const COURSE_PIN: Record<string, number> = { REAL6595: 0, REAL6640: 7, ASIAN4377: 3, REAL5560: 5, REAL5561: 8, HADM6205: 11, REAL6901: 9, GOVT1109: 4 };
const pinKey = (code: string) => String(code || "").toUpperCase().replace(/\s+/g, "");
// Distinct colour per course, identical algorithm to the app: pinned courses take their pin; everyone
// else fills the remaining (unpinned) palette slots in order — so no auto-assigned course hits a pin.
function assignCourseColors(list: { id: number; code?: string }[]): Record<string, number> {
  const map: Record<string, number> = {}; const pinned = new Set<number>();
  for (const e of list) { const p = COURSE_PIN[pinKey(e.code || "")]; if (p != null) pinned.add(p); }
  const avail = SCHED_COLORS.map((_, i) => i).filter((i) => !pinned.has(i)); let ai = 0;
  for (const e of list) { const k = e.code || ("#" + e.id); if (map[k] != null) continue;
    const p = COURSE_PIN[pinKey(e.code || "")];
    map[k] = (p != null) ? p : (avail.length ? avail[ai++ % avail.length] : (ai++ % SCHED_COLORS.length)); }
  return map;
}
// Google's fixed event-colour palette (API hex). "9" Blueberry is deliberately OMITTED — the user
// reserves that bright blue (#5484ed) for manually-entered events, so Carnelian never assigns it.
const GCOLORS: Record<string, string> = { "1": "#a4bdfc", "2": "#7ae7bf", "3": "#dbadff", "4": "#ff887c", "5": "#fbd75b", "6": "#ffb878", "7": "#46d6db", "10": "#51b749", "11": "#dc2127" };
function hexRgb(h: string) { h = h.replace("#", ""); return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)]; }
function hueOf(hex: string) { const [r, g, b] = hexRgb(hex).map((v) => v / 255); const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn; if (d === 0) return -1; let h; if (mx === r) h = ((g - b) / d) % 6; else if (mx === g) h = (b - r) / d + 2; else h = (r - g) / d + 4; h *= 60; return h < 0 ? h + 360 : h; }
function satOf(hex: string) { const [r, g, b] = hexRgb(hex).map((v) => v / 255); const mx = Math.max(r, g, b), mn = Math.min(r, g, b), l = (mx + mn) / 2, d = mx - mn; if (d === 0) return 0; return d / (1 - Math.abs(2 * l - 1)); }
// Nearest Google colourId for an app palette hex. Desaturated (grey) → Graphite "8"; else nearest hue
// among GCOLORS (Blueberry "9" excluded, reserved for the user's manual events).
function colorIdForHex(hex: string) {
  if (satOf(hex) < 0.18) return "8";
  const H = hueOf(hex); if (H < 0) return "8";
  let best = "1", bd = 1e9;
  for (const id in GCOLORS) { const gh = hueOf(GCOLORS[id]); if (gh < 0) continue; let dd = Math.abs(H - gh); if (dd > 180) dd = 360 - dd; if (dd < bd) { bd = dd; best = id; } }
  return best;
}
const colorIdForIndex = (i: number) => colorIdForHex(SCHED_COLORS[i % SCHED_COLORS.length]);
// Per-term course → Google colourId, matching the app's assignCourseColors exactly, so a course's
// classes and its deadlines share one colour. Built from all non-wishlist enrollments in current/
// upcoming terms; returns enrollment_id → colourId.
async function courseColorIds(): Promise<Map<number, string>> {
  const rows = await sql`select e.id, e.code, e.term_id from carnelian.enrollments e
    left join carnelian.terms t on t.id = e.term_id
    where coalesce(e.status, '') <> 'wishlist' and (t.ends_on is null or t.ends_on >= current_date)
    order by e.term_id, e.id`;
  const byTerm = new Map<string, any[]>();
  for (const e of rows as any[]) { const k = e.term_id || "_"; if (!byTerm.has(k)) byTerm.set(k, []); byTerm.get(k)!.push(e); }
  const out = new Map<number, string>();
  for (const [, list] of byTerm) { const idx = assignCourseColors(list);
    for (const e of list) { const key = e.code || ("#" + e.id); out.set(e.id, colorIdForIndex(idx[key])); } }
  return out;
}
const p2 = (n: number) => String(n).padStart(2, "0");
const hm = (s: string) => { const m = /^(\d{1,2}):(\d{2})$/.exec(s || ""); return m ? (+m[1]) * 60 + (+m[2]) : -1; };
function pdate(s: string | null | undefined) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(s || "")); return m ? new Date(+m[1], +m[2] - 1, +m[3]) : null;
}
function firstOccur(ws: Date, days: string[]) {
  const wanted = new Set(days.map((d) => DOW[d]));
  const d = new Date(ws.getFullYear(), ws.getMonth(), ws.getDate());
  for (let i = 0; i < 7; i++) { if (wanted.has(d.getDay())) return new Date(d); d.setDate(d.getDate() + 1); }
  return null;
}
function buildEvent(e: any, m: any, colorId: string, ta?: any) {
  const days = (m.days || []).filter((d: string) => BYDAY[d]);
  if (!days.length) return null;
  if (hm(m.start) < 0 || hm(m.end) < 0 || hm(m.end) <= hm(m.start)) return null;
  const ts = pdate(e.starts_on), te = pdate(e.ends_on);
  if (!ts || !te) return null;            // need term dates to place a recurring event
  // Class window from the academic calendar: classes end at the last day of instruction (not the
  // term's admin end date), and half-term (7-week) courses use their session bounds.
  const A = ta || { ts, te, mid: new Date((ts.getTime() + te.getTime()) / 2), classEnd: te, half1End: null, half2Start: null, noClass: [] };
  const part = (m.part === "1" || m.part === "2") ? m.part : "full";
  let ws: Date = A.ts || ts, we: Date = A.classEnd || te;
  if (part === "1") we = A.half1End || A.mid || te;
  else if (part === "2") ws = A.half2Start || A.mid || ts;
  const first = firstOccur(ws, days);
  if (!first) return null;
  const dstr = `${first.getFullYear()}-${p2(first.getMonth() + 1)}-${p2(first.getDate())}`;
  const [sh, sm] = m.start.split(":"), [eh, em] = m.end.split(":");
  const startDT = `${dstr}T${p2(+sh)}:${p2(+sm)}:00`;
  const endDT = `${dstr}T${p2(+eh)}:${p2(+em)}:00`;
  const until = new Date(we); until.setDate(until.getDate() + 1);
  const rrule = `RRULE:FREQ=WEEKLY;UNTIL=${until.getFullYear()}${p2(until.getMonth() + 1)}${p2(until.getDate())}T035959Z;BYDAY=${days.map((d: string) => BYDAY[d]).join(",")}`;
  // Exclude "No classes" break/holiday days that fall on this meeting's weekdays within the window.
  const wanted = new Set(days.map((d: string) => DOW[d]));
  const ex: string[] = [];
  for (const iv of (A.noClass || [])) {
    let d = new Date(Math.max(iv.s.getTime(), ws.getTime()));
    const end = new Date(Math.min(iv.e.getTime(), we.getTime()));
    for (; d <= end; d = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1)) {
      if (wanted.has(d.getDay())) ex.push(`${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}T${p2(+sh)}${p2(+sm)}00`);
    }
  }
  const recurrence = [rrule];
  if (ex.length) recurrence.push(`EXDATE;TZID=${TZ}:${ex.join(",")}`);
  const desc: string[] = [];
  const cs = `${m.component || ""} ${m.section || ""}`.trim(); if (cs) desc.push(cs);
  if (m.instructor) desc.push(m.instructor);
  desc.push("Synced from Carnelian");
  const summary = e.title ? (e.code ? `${e.title} (${e.code})` : e.title) : (e.code || "Course");
  const body: any = {
    summary,
    location: m.location || undefined,
    description: desc.join("\n"),
    colorId,
    start: { dateTime: startDT, timeZone: TZ },
    end: { dateTime: endDT, timeZone: TZ },
    recurrence,
  };
  const sig = JSON.stringify([summary, body.location || "", startDT, endDT, rrule, ex.join(","), colorId]);
  return { body, sig };
}

// Reconcile every non-wishlist enrollment-with-meetings against the calendar,
// touching only what changed (sig compare) so re-syncs are cheap and idempotent.
async function syncAll(access: string, calId: string) {
  // All non-wishlist enrollments in current/upcoming terms, ordered like the app
  // (per term, by id) so the per-course colour index matches the weekly grid.
  const rows = await sql`select e.id, e.code, e.title, e.meetings, e.term_id, t.starts_on::text as starts_on, t.ends_on::text as ends_on
    from carnelian.enrollments e left join carnelian.terms t on t.id = e.term_id
    where coalesce(e.status, '') <> 'wishlist'
      and (t.ends_on is null or t.ends_on >= current_date)
    order by e.term_id, e.id`;
  // Per-term academic structure (last day of instruction, breaks, 7-week bounds) for recurrence + EXDATE.
  const acEvents = await fetchAcademic();
  const taCache = new Map<string, any>();
  const taFor = (row: any) => {
    const key = row.term_id || "_";
    if (taCache.has(key)) return taCache.get(key);
    const ts = pdate(row.starts_on), te = pdate(row.ends_on);
    const ta = (ts && te) ? termAcademicsFor(acEvents, ts, te) : null;
    taCache.set(key, ta);
    return ta;
  };
  const colorIds = await courseColorIds();
  const desired = new Map<string, { enrId: number; mkey: string; body: any; sig: string }>();
  let skipped = 0;
  for (const e of rows as any[]) {
    const colorId = colorIds.get(e.id) || "8";
    const meetings = Array.isArray(e.meetings) ? e.meetings : [];
    const ta = taFor(e);
    meetings.forEach((m: any, i: number) => {
      const built = buildEvent(e, m, colorId, ta);
      if (!built) { skipped++; return; }
      desired.set(`${e.id}::${i}`, { enrId: e.id, mkey: String(i), body: built.body, sig: built.sig });
    });
  }
  const existing = await sql`select enrollment_id, mkey, event_id, sig from carnelian.gcal_events`;
  const exMap = new Map((existing as any[]).map((r) => [`${r.enrollment_id}::${r.mkey}`, r]));
  let created = 0, updated = 0, deleted = 0;
  const ev = (id: string) => `/calendars/${encodeURIComponent(calId)}/events/${encodeURIComponent(id)}`;

  for (const [key, d] of desired) {
    const ex = exMap.get(key);
    if (ex) {
      if (ex.sig === d.sig) continue;
      const { status } = await gapi(access, "PATCH", ev(ex.event_id), d.body);
      if (status === 404 || status === 410) {
        const ins = await gapi(access, "POST", `/calendars/${encodeURIComponent(calId)}/events`, d.body);
        if (ins.j?.id) { await sql`update carnelian.gcal_events set event_id = ${ins.j.id}, sig = ${d.sig} where enrollment_id = ${d.enrId} and mkey = ${d.mkey}`; created++; }
      } else {
        await sql`update carnelian.gcal_events set sig = ${d.sig} where enrollment_id = ${d.enrId} and mkey = ${d.mkey}`; updated++;
      }
    } else {
      const ins = await gapi(access, "POST", `/calendars/${encodeURIComponent(calId)}/events`, d.body);
      if (ins.j?.id) { await sql`insert into carnelian.gcal_events (enrollment_id, mkey, event_id, sig) values (${d.enrId}, ${d.mkey}, ${ins.j.id}, ${d.sig}) on conflict (enrollment_id, mkey) do update set event_id = ${ins.j.id}, sig = ${d.sig}`; created++; }
    }
  }
  for (const [key, r] of exMap) {
    if (desired.has(key)) continue;
    try { await gapi(access, "DELETE", ev(r.event_id)); } catch { /* ignore */ }
    await sql`delete from carnelian.gcal_events where enrollment_id = ${r.enrollment_id} and mkey = ${r.mkey}`;
    deleted++;
  }
  return { created, updated, deleted, skipped };
}

// Second Google calendar: Cornell academic dates (breaks/deadlines/finals) as all-day events,
// filtered to the user's cohort. Kept separate so it can be toggled independently of classes.
async function ensureAcademicCalendar(access: string) {
  const cfg = await gcalCfg();
  if (cfg.calendar_academic) return cfg.calendar_academic as string;
  const { status, j } = await gapi(access, "POST", "/calendars", { summary: "Carnelian - Academic", timeZone: TZ });
  if (status >= 300 || !j.id) throw new Error("could not create academic calendar");
  await sql`update carnelian.gcal_config set calendar_academic = ${j.id} where id = 1`;
  return j.id as string;
}
async function syncAcademic(access: string, calId: string) {
  const evs = (await fetchAcademic()).filter((ev: any) => acalRelevant(ev.title || ""));
  const desired = new Map<string, { body: any; sig: string }>();
  for (const ev of evs) {
    const s = acalStart(ev); if (!s) continue;
    const e = acalEnd(ev) || s;
    const start = dfmt(s);
    const end = dfmt(new Date(e.getFullYear(), e.getMonth(), e.getDate() + 1)); // all-day end is exclusive
    const summary = acalTitleShort(ev.title || "") || "Academic date";
    const akey = (await sha256hex(`${ev.month}|${ev.date}|${ev.title}`)).slice(0, 32);
    const body: any = { summary, description: "Cornell academic calendar\nSynced from Carnelian", transparency: "transparent", colorId: "8", start: { date: start }, end: { date: end } };
    desired.set(akey, { body, sig: JSON.stringify([summary, start, end]) });
  }
  const existing = await sql`select akey, event_id, sig from carnelian.gcal_academic`;
  const exMap = new Map((existing as any[]).map((r) => [r.akey, r]));
  let created = 0, updated = 0, deleted = 0;
  const ev = (id: string) => `/calendars/${encodeURIComponent(calId)}/events/${encodeURIComponent(id)}`;
  for (const [akey, d] of desired) {
    const ex = exMap.get(akey);
    if (ex) {
      if (ex.sig === d.sig) continue;
      const { status } = await gapi(access, "PATCH", ev(ex.event_id), d.body);
      if (status === 404 || status === 410) {
        const ins = await gapi(access, "POST", `/calendars/${encodeURIComponent(calId)}/events`, d.body);
        if (ins.j?.id) { await sql`update carnelian.gcal_academic set event_id = ${ins.j.id}, sig = ${d.sig} where akey = ${akey}`; created++; }
      } else { await sql`update carnelian.gcal_academic set sig = ${d.sig} where akey = ${akey}`; updated++; }
    } else {
      const ins = await gapi(access, "POST", `/calendars/${encodeURIComponent(calId)}/events`, d.body);
      if (ins.j?.id) { await sql`insert into carnelian.gcal_academic (akey, event_id, sig) values (${akey}, ${ins.j.id}, ${d.sig}) on conflict (akey) do update set event_id = ${ins.j.id}, sig = ${d.sig}`; created++; }
    }
  }
  for (const [akey, r] of exMap) {
    if (desired.has(akey)) continue;
    try { await gapi(access, "DELETE", ev(r.event_id)); } catch { /* ignore */ }
    await sql`delete from carnelian.gcal_academic where akey = ${akey}`;
    deleted++;
  }
  return { created, updated, deleted };
}

// Third Google calendar: per-class assignment deadlines. The user's rule — a deadline with a TIME
// becomes a timed event on the grid; one with NO time stays an all-day event at the top. Placement
// mirrors the app's Schedule: exams/quizzes are timed blocks at the real due date/time spanning
// duration_min (busy); every other deadline uses the work-by target (target_on/target_time, falling
// back to the real deadline) as a short marker ENDING at that time (free, so it never marks you busy
// and an 11:59pm deadline stays on its own day), or an all-day event when it carries no time.
const KIND_TIMED_SET = new Set(["exam", "quiz"]);
const DEADLINE_MARKER_MIN = 30;
function fmt12(t: string) { const m = /^(\d{1,2}):(\d{2})/.exec(t || ""); if (!m) return t || ""; let h = +m[1]; const ap = h >= 12 ? "PM" : "AM"; h = h % 12 || 12; return `${h}:${m[2]} ${ap}`; }
// Shift a wall-clock time (hh:mm on YYYY-MM-DD) by delta minutes, rolling the date across midnight.
function shiftClock(dstr: string, hh: number, mm: number, delta: number) {
  // round to whole minutes: durations can be fractional (e.g. a 112.5-min exam), and Google needs HH:MM
  const d = pdate(dstr)!; let total = Math.round(hh * 60 + mm + delta); const day = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  while (total < 0) { total += 1440; day.setDate(day.getDate() - 1); }
  while (total >= 1440) { total -= 1440; day.setDate(day.getDate() + 1); }
  return { date: `${day.getFullYear()}-${p2(day.getMonth() + 1)}-${p2(day.getDate())}`, h: Math.floor(total / 60), m: total % 60 };
}
function buildDeadlineEvent(a: any, colorId: string) {
  const dueDate = String(a.due_on || "").slice(0, 10); if (!dueDate) return null;
  const title = a.name || "Assignment";
  const summary = a.code ? `${title} (${a.code})` : title;
  const timed = KIND_TIMED_SET.has(a.kind);
  const placeDate = timed ? dueDate : String((a.target_on || a.due_on) || "").slice(0, 10);
  const placeTime = timed ? (a.due_time || null) : (a.target_on ? (a.target_time || null) : (a.due_time || null));
  if (!placeDate) return null;
  const desc: string[] = [];
  if (a.title_course) desc.push(a.title_course);
  desc.push(a.due_time ? `Due ${dueDate} ${fmt12(a.due_time)}` : `Due ${dueDate}`);
  desc.push("Synced from Carnelian");
  const description = desc.join("\n");
  let body: any, sigKey: any[];
  if (!placeTime) {
    const d = pdate(placeDate)!; const ex = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1);
    const endStr = `${ex.getFullYear()}-${p2(ex.getMonth() + 1)}-${p2(ex.getDate())}`;
    body = { summary, description, colorId, transparency: "transparent", start: { date: placeDate }, end: { date: endStr } };
    sigKey = [summary, "allday", placeDate, colorId];
  } else {
    const [hh, mm] = placeTime.split(":").map((x: string) => +x);
    let s, e;
    if (timed) { const dur = (a.duration_min != null && isFinite(+a.duration_min) && +a.duration_min > 0) ? +a.duration_min : 60;
      s = { date: placeDate, h: hh, m: mm }; e = shiftClock(placeDate, hh, mm, dur); }
    else { e = { date: placeDate, h: hh, m: mm }; s = shiftClock(placeDate, hh, mm, -DEADLINE_MARKER_MIN); }
    const startDT = `${s.date}T${p2(s.h)}:${p2(s.m)}:00`, endDT = `${e.date}T${p2(e.h)}:${p2(e.m)}:00`;
    body = { summary, description, colorId, start: { dateTime: startDT, timeZone: TZ }, end: { dateTime: endDT, timeZone: TZ } };
    if (!timed) body.transparency = "transparent"; // a deadline marker shouldn't mark you busy; an exam should
    sigKey = [summary, "timed", startDT, endDT, colorId];
  }
  return { body, sig: JSON.stringify(sigKey) };
}
async function ensureDeadlinesCalendar(access: string) {
  const cfg = await gcalCfg();
  if (cfg.calendar_deadlines) return cfg.calendar_deadlines as string;
  const { status, j } = await gapi(access, "POST", "/calendars", { summary: "Carnelian - Deadlines", timeZone: TZ });
  if (status >= 300 || !j.id) throw new Error("could not create deadlines calendar");
  await sql`update carnelian.gcal_config set calendar_deadlines = ${j.id} where id = 1`;
  return j.id as string;
}
async function syncDeadlines(access: string, calId: string) {
  const colorIds = await courseColorIds();
  // Reviewed (non-pending) assignments on courses in current/upcoming terms — exactly what the app's Schedule shows.
  const rows = await sql`select a.id, a.enrollment_id, a.name, a.kind, a.due_on::text as due_on, a.due_time::text as due_time,
      a.duration_min, a.target_on::text as target_on, a.target_time::text as target_time,
      e.code as code, e.title as title_course
    from carnelian.assignments a
    join carnelian.enrollments e on e.id = a.enrollment_id
    left join carnelian.terms t on t.id = e.term_id
    where coalesce(a.status, '') <> 'pending' and coalesce(e.status, '') <> 'wishlist'
      and (t.ends_on is null or t.ends_on >= current_date)
    order by a.id`;
  const desired = new Map<string, { body: any; sig: string }>();
  for (const a of rows as any[]) {
    const colorId = colorIds.get(a.enrollment_id) || "8";
    const built = buildDeadlineEvent(a, colorId);
    if (built) desired.set(String(a.id), built);
  }
  const existing = await sql`select dkey, event_id, sig from carnelian.gcal_deadlines`;
  const exMap = new Map((existing as any[]).map((r) => [r.dkey, r]));
  let created = 0, updated = 0, deleted = 0;
  const ev = (id: string) => `/calendars/${encodeURIComponent(calId)}/events/${encodeURIComponent(id)}`;
  for (const [dkey, d] of desired) {
    const ex = exMap.get(dkey);
    if (ex) {
      if (ex.sig === d.sig) continue;
      const { status } = await gapi(access, "PATCH", ev(ex.event_id), d.body);
      if (status === 404 || status === 410) {
        const ins = await gapi(access, "POST", `/calendars/${encodeURIComponent(calId)}/events`, d.body);
        if (ins.j?.id) { await sql`update carnelian.gcal_deadlines set event_id = ${ins.j.id}, sig = ${d.sig} where dkey = ${dkey}`; created++; }
      } else { await sql`update carnelian.gcal_deadlines set sig = ${d.sig} where dkey = ${dkey}`; updated++; }
    } else {
      const ins = await gapi(access, "POST", `/calendars/${encodeURIComponent(calId)}/events`, d.body);
      if (ins.j?.id) { await sql`insert into carnelian.gcal_deadlines (dkey, event_id, sig) values (${dkey}, ${ins.j.id}, ${d.sig}) on conflict (dkey) do update set event_id = ${ins.j.id}, sig = ${d.sig}`; created++; }
    }
  }
  for (const [dkey, r] of exMap) {
    if (desired.has(dkey)) continue;
    try { await gapi(access, "DELETE", ev(r.event_id)); } catch { /* ignore */ }
    await sql`delete from carnelian.gcal_deadlines where dkey = ${dkey}`;
    deleted++;
  }
  return { created, updated, deleted };
}

// ================= Cornell academic calendar (deterministic scrape) =================
// The registrar page has no CORS headers, so the browser can't fetch it -- we do it here and parse
// the fixed markup: <h3>Month YYYY</h3> group headers + .calendar-row-item blocks each holding a
// .calendar-date, an optional .calendar-time, and a .calendar-date-title. Pure regex, no AI.
const ACAL_URL = "https://registrar.cornell.edu/calendars-exams/academic-calendar";
function acalDecode(s: string) {
  return s
    .replace(/&#(\d+);/g, (_m, n) => String.fromCharCode(+n))
    .replace(/&#x([0-9a-fA-F]+);/g, (_m, n) => String.fromCharCode(parseInt(n, 16)))
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">");
}
function acalClean(s: string) {
  return acalDecode(String(s || "").replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim();
}
function parseAcademicCalendar(html: string) {
  const tM = /<h1[^>]*>\s*(Academic Calendar[^<]*)</i.exec(html);
  const title = tM ? acalClean(tM[1]) : "Academic Calendar";
  const events: { month: string; date: string; time: string; title: string }[] = [];
  let month = "";
  const re = /<h3>\s*([\s\S]*?)\s*<\/h3>|<div class="calendar-row-item[\s\S]*?<span class="calendar-date">\s*([\s\S]*?)\s*<\/span>([\s\S]*?)<span class="calendar-date-title">\s*([\s\S]*?)\s*<\/span>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    if (m[1] !== undefined) {
      const h = acalClean(m[1]);
      if (/^[A-Z][a-z]+ \d{4}$/.test(h)) month = h;
      continue;
    }
    const date = acalClean(m[2]);
    const timeM = /<span class="calendar-time">\s*([\s\S]*?)\s*<\/span>/.exec(m[3] || "");
    const time = timeM ? acalClean(timeM[1]) : "";
    const t = acalClean(m[4]);
    if (date || t) events.push({ month, date, time, title: t });
  }
  return { title, events };
}

// Cache the scraped academic calendar for a warm isolate so one sync doesn't refetch the registrar.
let ACAL_CACHE: { at: number; events: any[] } | null = null;
async function fetchAcademic(): Promise<any[]> {
  if (ACAL_CACHE && Date.now() - ACAL_CACHE.at < 3600_000) return ACAL_CACHE.events;
  try {
    const ac = new AbortController();
    const to = setTimeout(() => ac.abort(), 10000);
    const res = await fetch(ACAL_URL, { headers: { "user-agent": "Mozilla/5.0 (Carnelian degree tracker)" }, signal: ac.signal });
    clearTimeout(to);
    const parsed = parseAcademicCalendar(await res.text());
    ACAL_CACHE = { at: Date.now(), events: parsed.events };
    return parsed.events;
  } catch { return ACAL_CACHE?.events ?? []; }
}
const ACAL_MON: Record<string, number> = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 };
function acalYear(ev: any) { const m = /(\d{4})/.exec(ev.month || ""); return m ? +m[1] : new Date().getFullYear(); }
function acalStart(ev: any): Date | null { const m = /([A-Z][a-z]{2})\s+(\d{1,2})/.exec(ev.date || ""); if (!m) return null; const mo = ACAL_MON[m[1]]; if (mo == null) return null; return new Date(acalYear(ev), mo, +m[2]); }
function acalEnd(ev: any): Date | null { const all = [...String(ev.date || "").matchAll(/([A-Z][a-z]{2})\s+(\d{1,2})/g)]; if (all.length < 2) return acalStart(ev); const last = all[all.length - 1]; const mo = ACAL_MON[last[1]]; const s = acalStart(ev); if (mo == null || !s) return s; let y = acalYear(ev); if (mo < s.getMonth()) y++; return new Date(y, mo, +last[2]); }
// Hide enrollment/add-drop notices aimed at cohorts that aren't the user (Baker = Graduate/Professional + senior).
function acalRelevant(title: string) { return !/\bfor\s+(Juniors?|Sophomores?|First[-\s]?Years?)\b/i.test(String(title || "")); }
function acalTitleShort(t: string) { return String(t || "").replace(/^(Fall|Spring|Winter|Summer)\s+\d{4}:\s*/i, "").trim(); }
// Server mirror of the app's termAcademics: no-class ranges, last day of instruction, 7-week bounds.
function termAcademicsFor(evs: any[], ts: Date, te: Date) {
  const mid = new Date((ts.getTime() + te.getTime()) / 2);
  const res: any = { ts, te, mid, noClass: [] as { s: Date; e: Date }[], classEnd: te, half1End: null as Date | null, half2Start: null as Date | null };
  let lastInstr: Date | null = null;
  for (const ev of evs) {
    const s = acalStart(ev); if (!s) continue; const e = acalEnd(ev) || s;
    if (e < ts || s > te) continue;
    const title = ev.title || "";
    if (/no class/i.test(title)) res.noClass.push({ s, e });
    if (/last day of instruction/i.test(title)) { if (/7\s*week\s*1/i.test(title)) res.half1End = e; else if (!/7\s*week/i.test(title)) { if (!lastInstr || e > lastInstr) lastInstr = e; } }
    if (/7\s*week\s*2/i.test(title) && /instruction begins/i.test(title)) res.half2Start = s;
  }
  if (lastInstr) res.classEnd = lastInstr;
  return res;
}
const dfmt = (d: Date) => `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;

function connectPage(msg: string, ok: boolean) {
  const back = ok ? `<p style="margin-top:14px"><a href="${APP_URL}" style="color:#A81F23;font-weight:700;text-decoration:none">Back to Carnelian ›</a></p>` : "";
  return new Response(
    `<!doctype html><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1"><title>Carnelian</title><body style="font-family:-apple-system,BlinkMacSystemFont,system-ui,sans-serif;background:#FAF7F4;color:#1E1A18;display:grid;place-items:center;min-height:100vh;margin:0;text-align:center;padding:24px"><div><div style="width:52px;height:52px;border-radius:15px;background:#A81F23;color:#fff;display:grid;place-items:center;font-weight:800;font-size:26px;margin:0 auto 16px">C</div><h2 style="font-weight:800;font-size:19px">${msg}</h2>${back}</div>`,
    { status: ok ? 200 : 400, headers: { "content-type": "text/html; charset=utf-8" } },
  );
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  // Google OAuth redirect lands here as a top-level GET (code + state).
  if (req.method === "GET") {
    const url = new URL(req.url);
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");
    const oerr = url.searchParams.get("error");
    if (!code && !oerr) return json({ ok: true, service: "carnelian" });
    try {
      if (oerr) return connectPage("Google sign-in was cancelled.", false);
      const cfg = await gcalCfg();
      if (!state || !cfg.oauth_state || state !== cfg.oauth_state) return connectPage("Security check failed — please connect again from the app.", false);
      if (cfg.oauth_state_at && Date.now() - new Date(cfg.oauth_state_at).getTime() > 15 * 60000) return connectPage("This link expired — please connect again from the app.", false);
      await exchangeCode(code!);
      const access = await accessToken();
      const calId = await ensureCalendar(access);
      try { await syncAll(access, calId); } catch { /* first sync best-effort; app retries on return */ }
      return new Response(null, { status: 302, headers: { location: APP_URL + "?gcal=connected" } });
    } catch (e) {
      return connectPage("Couldn't connect: " + String((e as Error)?.message ?? e), false);
    }
  }

  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  let body: any;
  try { body = await req.json(); } catch { return json({ error: "bad json" }, 400); }
  const action = body.action as string;

  try {
    if (action === "status") {
      const cfg = await getConfig();
      return json({ ok: true, initialized: !!cfg.passcode_hash });
    }
    if (action === "setup") {
      const cfg = await getConfig();
      if (cfg.passcode_hash) return json({ error: "already initialized" }, 409);
      const pc = String(body.passcode ?? "");
      if (pc.length < 4) return json({ error: "passcode must be at least 4 characters" }, 400);
      await sql`update carnelian.app_config set passcode_hash = ${await hashPasscode(pc)}, updated_at = now() where id = 1`;
      const token = newToken();
      await addSession(token);
      return json({ ok: true, token });
    }
    if (action === "login") {
      const cfg = await getConfig();
      if (!cfg.passcode_hash) return json({ error: "not initialized" }, 409);
      if (!(await verifyPasscode(String(body.passcode ?? ""), cfg.passcode_hash))) {
        return json({ error: "wrong passcode" }, 401);
      }
      const token = newToken();
      await addSession(token);
      return json({ ok: true, token });
    }

    // ---- authenticated actions ----
    if (!(await authed(body.token))) return json({ error: "unauthorized" }, 401);

    if (action === "load") {
      const [terms, programs, requirements, requirement_options, enrollments, adjustments, assignments, satisfactions, cfg] =
        await Promise.all([
          sql`select * from carnelian.terms order by sort`,
          sql`select * from carnelian.programs order by sort`,
          sql`select * from carnelian.requirements order by sort`,
          sql`select * from carnelian.requirement_options order by id`,
          sql`select * from carnelian.enrollments order by id`,
          sql`select * from carnelian.adjustments order by id`,
          sql`select * from carnelian.assignments order by sort`,
          sql`select * from carnelian.satisfactions order by id`,
          getConfig(),
        ]);
      const settings = { ...(cfg.settings ?? {}) };
      delete settings.sessions;
      return json({ ok: true, data: { terms, programs, requirements, requirement_options, enrollments, adjustments, assignments, satisfactions, settings } });
    }
    if (action === "upsert") return json({ ok: true, row: await upsert(body.table, body.row ?? {}) });
    if (action === "delete") {
      if (!COLS[body.table]) return json({ error: "table not allowed" }, 400);
      await sql`delete from carnelian.${sql(body.table)} where id = ${body.id}`;
      return json({ ok: true });
    }
    if (action === "update_settings") {
      const cfg = await getConfig();
      const merged = { ...(cfg.settings ?? {}), ...(body.settings ?? {}) };
      merged.sessions = cfg.settings?.sessions ?? [];
      await sql`update carnelian.app_config set settings = ${sql.json(merged)}, updated_at = now() where id = 1`;
      return json({ ok: true });
    }

    // ---- Cornell academic calendar (server-side scrape; registrar has no CORS) ----
    if (action === "academic_calendar") {
      try {
        const ac = new AbortController();
        const to = setTimeout(() => ac.abort(), 10000);
        const res = await fetch(ACAL_URL, { headers: { "user-agent": "Mozilla/5.0 (Carnelian degree tracker)" }, signal: ac.signal });
        clearTimeout(to);
        const html = await res.text();
        const parsed = parseAcademicCalendar(html);
        return json({ ok: true, source: ACAL_URL, ...parsed });
      } catch (e) {
        return json({ error: "Couldn't fetch the academic calendar: " + String((e as Error)?.message ?? e) }, 502);
      }
    }

    // ---- Google Calendar ----
    if (action === "gcal_status") {
      const cfg = await gcalCfg();
      const cnt = (await sql`select count(*)::int as n from carnelian.gcal_events`)[0].n;
      const acnt = (await sql`select count(*)::int as n from carnelian.gcal_academic`)[0].n;
      const dcnt = (await sql`select count(*)::int as n from carnelian.gcal_deadlines`)[0].n;
      return json({ ok: true, connected: !!cfg.refresh_token, email: cfg.email ?? null, calendar: !!cfg.calendar_id, count: cnt, sync_academic: !!cfg.sync_academic, academic_count: acnt, sync_deadlines: !!cfg.sync_deadlines, deadline_count: dcnt });
    }
    if (action === "gcal_auth_url") {
      if (!GOOGLE_CLIENT_SECRET) return json({ error: "Server is missing GOOGLE_CLIENT_SECRET — set it in Supabase Edge Function secrets." }, 500);
      const state = newToken();
      await sql`update carnelian.gcal_config set oauth_state = ${state}, oauth_state_at = now() where id = 1`;
      const u = new URL("https://accounts.google.com/o/oauth2/v2/auth");
      u.searchParams.set("client_id", GOOGLE_CLIENT_ID);
      u.searchParams.set("redirect_uri", REDIRECT_URI);
      u.searchParams.set("response_type", "code");
      u.searchParams.set("scope", GCAL_SCOPES);
      u.searchParams.set("access_type", "offline");
      u.searchParams.set("prompt", "consent");
      u.searchParams.set("include_granted_scopes", "true");
      u.searchParams.set("state", state);
      return json({ ok: true, url: u.toString() });
    }
    if (action === "gcal_sync") {
      try {
        const access = await accessToken();
        const calId = await ensureCalendar(access);
        const res = await syncAll(access, calId);
        let academic = null, deadlines = null;
        const cfg = await gcalCfg();
        if (cfg.sync_academic) { const acId = await ensureAcademicCalendar(access); academic = await syncAcademic(access, acId); }
        if (cfg.sync_deadlines) { const dlId = await ensureDeadlinesCalendar(access); deadlines = await syncDeadlines(access, dlId); }
        return json({ ok: true, ...res, academic, deadlines });
      } catch (e) {
        if (e && (e as any).reauth) return json({ ok: false, reconnect: true, error: "reauth" });
        return json({ error: String((e as Error)?.message ?? e) }, 500);
      }
    }
    // Toggle the academic-dates layer: on → create/sync its calendar; off → delete it and forget it.
    if (action === "gcal_academic_toggle") {
      try {
        const on = !!body.enabled;
        await sql`update carnelian.gcal_config set sync_academic = ${on} where id = 1`;
        if (on) {
          const access = await accessToken();
          const acId = await ensureAcademicCalendar(access);
          const res = await syncAcademic(access, acId);
          return json({ ok: true, sync_academic: true, ...res });
        }
        const cfg = await gcalCfg();
        if (cfg.calendar_academic) {
          const access = await accessToken().catch(() => null);
          if (access) { try { await gapi(access, "DELETE", `/calendars/${encodeURIComponent(cfg.calendar_academic)}`); } catch { /* ignore */ } }
        }
        await sql`delete from carnelian.gcal_academic`;
        await sql`update carnelian.gcal_config set calendar_academic = null where id = 1`;
        return json({ ok: true, sync_academic: false });
      } catch (e) {
        if (e && (e as any).reauth) return json({ ok: false, reconnect: true, error: "reauth" });
        return json({ error: String((e as Error)?.message ?? e) }, 500);
      }
    }
    // Toggle the class-deadlines layer: on → create/sync its calendar; off → delete it and forget it.
    if (action === "gcal_deadlines_toggle") {
      try {
        const on = !!body.enabled;
        await sql`update carnelian.gcal_config set sync_deadlines = ${on} where id = 1`;
        if (on) {
          const access = await accessToken();
          const dlId = await ensureDeadlinesCalendar(access);
          const res = await syncDeadlines(access, dlId);
          return json({ ok: true, sync_deadlines: true, ...res });
        }
        const cfg = await gcalCfg();
        if (cfg.calendar_deadlines) {
          const access = await accessToken().catch(() => null);
          if (access) { try { await gapi(access, "DELETE", `/calendars/${encodeURIComponent(cfg.calendar_deadlines)}`); } catch { /* ignore */ } }
        }
        await sql`delete from carnelian.gcal_deadlines`;
        await sql`update carnelian.gcal_config set calendar_deadlines = null where id = 1`;
        return json({ ok: true, sync_deadlines: false });
      } catch (e) {
        if (e && (e as any).reauth) return json({ ok: false, reconnect: true, error: "reauth" });
        return json({ error: String((e as Error)?.message ?? e) }, 500);
      }
    }
    if (action === "gcal_disconnect") {
      const cfg = await gcalCfg();
      try {
        if (cfg.refresh_token) {
          const access = await accessToken().catch(() => null);
          if (access && cfg.calendar_id) { try { await gapi(access, "DELETE", `/calendars/${encodeURIComponent(cfg.calendar_id)}`); } catch { /* ignore */ } }
          if (access && cfg.calendar_academic) { try { await gapi(access, "DELETE", `/calendars/${encodeURIComponent(cfg.calendar_academic)}`); } catch { /* ignore */ } }
          if (access && cfg.calendar_deadlines) { try { await gapi(access, "DELETE", `/calendars/${encodeURIComponent(cfg.calendar_deadlines)}`); } catch { /* ignore */ } }
          await fetch("https://oauth2.googleapis.com/revoke?token=" + encodeURIComponent(cfg.refresh_token), { method: "POST" }).catch(() => {});
        }
      } catch { /* ignore */ }
      await sql`delete from carnelian.gcal_events`;
      await sql`delete from carnelian.gcal_academic`;
      await sql`delete from carnelian.gcal_deadlines`;
      await sql`update carnelian.gcal_config set refresh_token = null, access_token = null, access_expiry = null, calendar_id = null, calendar_academic = null, sync_academic = false, calendar_deadlines = null, sync_deadlines = false, email = null, connected_at = null, oauth_state = null, oauth_state_at = null where id = 1`;
      return json({ ok: true });
    }

    return json({ error: "unknown action" }, 400);
  } catch (err) {
    return json({ error: String((err as Error)?.message ?? err) }, 500);
  }
});
