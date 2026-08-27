// Pure iCalendar parsing + mapping helpers for the Canvas deadline sync.
// No Deno/Node-specific APIs — only Date, RegExp, String, Intl — so it runs
// unchanged in the Deno edge function (prod) and under `node --test` (local).

export type RawEvent = {
  uid: string;
  summary: string;
  dtstart: string; // right-hand side incl. any ;PARAMS and the value
  dtend: string;
  url: string;
  description: string;
};

// iCal folds long lines by inserting CRLF + a single space/tab. Normalize line
// endings, then splice folded continuations back together.
export function unfoldIcal(text: string): string {
  return String(text).replace(/\r\n/g, "\n").replace(/\n[ \t]/g, "");
}

function unescapeIcal(s: string): string {
  return String(s)
    .replace(/\\n/gi, " ")
    .replace(/\\,/g, ",")
    .replace(/\\;/g, ";")
    .replace(/\\\\/g, "\\")
    .trim();
}

// Parse VEVENT blocks. Property values keep only what we need; DTSTART/DTEND keep
// their full right-hand side (params + value) so icalDateToET can read the type.
export function parseVEvents(text: string): RawEvent[] {
  const s = unfoldIcal(text);
  const out: RawEvent[] = [];
  const blocks = s.split(/BEGIN:VEVENT/).slice(1);
  for (const b of blocks) {
    const body = b.split(/END:VEVENT/)[0];
    const ev: RawEvent = { uid: "", summary: "", dtstart: "", dtend: "", url: "", description: "" };
    for (const line of body.split("\n")) {
      const t = line.trim();
      const m = /^([A-Za-z-]+)([;:])([\s\S]*)$/.exec(t);
      if (!m) continue;
      const name = m[1].toUpperCase();
      const rhs = m[2] + m[3]; // includes the leading ; or :
      const colon = rhs.indexOf(":");
      const value = colon >= 0 ? rhs.slice(colon + 1) : "";
      if (name === "UID") ev.uid = value;
      else if (name === "SUMMARY") ev.summary = value;
      else if (name === "DTSTART") ev.dtstart = rhs;
      else if (name === "DTEND") ev.dtend = rhs;
      else if (name === "URL") ev.url = value;
      else if (name === "DESCRIPTION") ev.description = value;
    }
    if (ev.uid || ev.summary) out.push(ev);
  }
  return out;
}

// Convert a DTSTART right-hand side to a New-York local date + time.
//  - `…Z`            UTC datetime → converted to ET via Intl (correct DST).
//  - `VALUE=DATE`    all-day → date only, time null.
//  - `TZID=…`/float  wall-clock taken as-is (assumed ET).
export function icalDateToET(raw: string): { due_on: string | null; due_time: string | null } {
  if (!raw) return { due_on: null, due_time: null };
  const colon = raw.indexOf(":");
  const params = colon >= 0 ? raw.slice(0, colon) : "";
  const val = (colon >= 0 ? raw.slice(colon + 1) : raw).trim();
  const md = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?)?(Z)?/.exec(val);
  if (!md) return { due_on: null, due_time: null };
  const [, Y, M, D, H, Mi, S, Z] = md;
  const isDate = /VALUE=DATE/i.test(params) || H === undefined;
  if (isDate) return { due_on: `${Y}-${M}-${D}`, due_time: null };
  if (Z) {
    const d = new Date(Date.UTC(+Y, +M - 1, +D, +H, +Mi, +(S || 0)));
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York",
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", hourCycle: "h23",
    }).formatToParts(d);
    const g = (t: string) => parts.find((x) => x.type === t)!.value;
    return { due_on: `${g("year")}-${g("month")}-${g("day")}`, due_time: `${g("hour")}:${g("minute")}` };
  }
  return { due_on: `${Y}-${M}-${D}`, due_time: `${H}:${Mi}` };
}

// Normalize any code-ish string to letters+digits only (for matching enrollment codes).
export function normCode(s: string): string {
  return String(s || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
}

// All SUBJECT+NUMBER course keys in a string, ignoring term tokens (FA26 / 2026FA).
// A cross-listed Canvas tag like "[CEE5950/ENMGT5950/REAL5950]" yields every code
// so the caller can pick whichever one the user is actually enrolled in.
export function courseKeys(s: string): string[] {
  let u = String(s || "").toUpperCase();
  u = u.replace(/\b(FA|SP|SU|WI)\s*-?_?\s*\d{2,4}\b/g, " ").replace(/\b\d{4}\s*-?_?\s*(FA|SP|SU|WI)\b/g, " ");
  const out: string[] = [];
  const re = /([A-Z]{2,5})[\s\-_]*(\d{4})/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(u))) out.push(m[1] + m[2]);
  return out;
}
// First course key (convenience).
export function courseKey(s: string): string { return courseKeys(s)[0] || ""; }

// Guess the assignment kind from the title. Kinds match the app's fixed set.
export function guessKind(summary: string): string {
  const t = String(summary || "").toLowerCase();
  if (/\bquiz(zes)?\b/.test(t)) return "quiz";
  if (/\b(exam|midterm|final|prelim)\b/.test(t)) return "exam";
  if (/\b(problem\s*set|p-?set)\b/.test(t)) return "problem_set";
  if (/\b(paper|essay)\b/.test(t)) return "paper";
  if (/\bpresentation\b/.test(t)) return "presentation";
  if (/\bproject\b/.test(t)) return "project";
  if (/\breading\b/.test(t)) return "reading";
  if (/\bdraft\b/.test(t)) return "draft";
  if (/\bsurvey\b/.test(t)) return "survey";
  return "assignment";
}

// Clean a raw SUMMARY into a display title: unescape and drop a trailing [course tag].
export function cleanSummary(summary: string): string {
  const s = unescapeIcal(summary).replace(/\s*\[[^\]]*\]\s*$/, "");
  return s.trim();
}
