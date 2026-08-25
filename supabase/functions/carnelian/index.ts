// Carnelian — passcode-gated data gateway.
// Runs inside Supabase; talks to the private `carnelian` schema over the
// function's own DB connection (SUPABASE_DB_URL). No Supabase keys or secrets
// ever reach the public site — the browser sends only a passcode/session token.
import postgres from "https://deno.land/x/postgresjs@v3.4.5/mod.js";

const sql = postgres(Deno.env.get("SUPABASE_DB_URL")!, { prepare: false, ssl: "require" });

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type, authorization, apikey",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, status = 200) =>
  new Response(JSON.stringify(b), { status, headers: { ...CORS, "content-type": "application/json" } });

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
  enrollments: ["code", "title", "credits", "term_id", "status", "grade", "gpa_points", "counts_gpa", "pinned_requirement_id", "tags", "offered_terms", "notes", "analog_of", "in_as", "meetings"],
  terms: ["id", "name", "career", "kind", "starts_on", "ends_on", "sort"],
  adjustments: ["program_id", "type", "from_requirement_id", "to_requirement_id", "satisfies_requirement_id", "credits", "trigger_course", "note"],
  assignments: ["enrollment_id", "name", "weight", "score", "due_on", "sort"],
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

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
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

    return json({ error: "unknown action" }, 400);
  } catch (err) {
    return json({ error: String((err as Error)?.message ?? err) }, 500);
  }
});
