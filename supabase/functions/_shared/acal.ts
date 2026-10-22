// Cornell registrar academic calendar: scrape parser plus the term rules Carnelian
// derives from it (no-class ranges, last day of instruction, 7-week halves).
// Pure string/RegExp code, shared by the `carnelian` and `wall` functions and
// runnable under `node --test`. Dates are plain "YYYY-MM-DD" strings, which
// compare correctly as text and never shift with the runtime's time zone.

export const ACAL_URL = "https://registrar.cornell.edu/calendars-exams/academic-calendar";

export type AcalEvent = { month: string; date: string; time: string; title: string };

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

// The registrar page renders a fixed markup: <h3>Month YYYY</h3> group headers and
// .calendar-row-item blocks, each holding a .calendar-date, an optional .calendar-time,
// and a .calendar-date-title.
export function parseAcademicCalendar(html: string) {
  const tM = /<h1[^>]*>\s*(Academic Calendar[^<]*)</i.exec(html);
  const title = tM ? acalClean(tM[1]) : "Academic Calendar";
  const events: AcalEvent[] = [];
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

const MON: Record<string, number> = { Jan: 1, Feb: 2, Mar: 3, Apr: 4, May: 5, Jun: 6, Jul: 7, Aug: 8, Sep: 9, Oct: 10, Nov: 11, Dec: 12 };
const p2 = (n: number) => String(n).padStart(2, "0");
const iso = (y: number, mo: number, d: number) => `${y}-${p2(mo)}-${p2(d)}`;

// An entry's first and last day ("Oct 10 - Oct 13" spans both; a range into the
// next month rolls the year when it wraps past December).
export function acalRange(ev: AcalEvent): { start: string; end: string } | null {
  const ym = /(\d{4})/.exec(ev.month || "");
  const y = ym ? +ym[1] : new Date().getFullYear();
  const all = [...String(ev.date || "").matchAll(/([A-Z][a-z]{2})\s+(\d{1,2})/g)].filter((x) => MON[x[1]]);
  if (!all.length) return null;
  const smo = MON[all[0][1]];
  const start = iso(y, smo, +all[0][2]);
  if (all.length < 2) return { start, end: start };
  const last = all[all.length - 1], emo = MON[last[1]];
  return { start, end: iso(emo < smo ? y + 1 : y, emo, +last[2]) };
}

// Hide enrollment and add/drop notices aimed at cohorts that aren't Matt (Baker is
// Graduate/Professional). Everything universal (breaks, finals, term bounds) stays.
export function acalRelevant(title: string) {
  return !/\bfor\s+(Juniors?|Sophomores?|First[-\s]?Years?)\b/i.test(String(title || ""));
}
export const acalNoClass = (title: string) => /no class/i.test(String(title || ""));

export function addDays(day: string, n: number) {
  const [y, mo, d] = day.split("-").map(Number);
  const t = new Date(Date.UTC(y, mo - 1, d + n));
  return iso(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate());
}
export function midpoint(a: string, b: string) {
  const [ay, am, ad] = a.split("-").map(Number), [by, bm, bd] = b.split("-").map(Number);
  const t = new Date((Date.UTC(ay, am - 1, ad) + Date.UTC(by, bm - 1, bd)) / 2);
  return iso(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate());
}

export type TermAcademics = {
  ts: string; te: string; mid: string;
  noClass: { start: string; end: string; title: string }[];
  classEnd: string; half1End: string | null; half2Start: string | null; half2End: string | null; has: boolean;
};

// Mirrors the app's termAcademics: "No classes" ranges, the last day of
// instruction (classes stop after it), and the 7-week half boundaries, including
// the second half's own last day. Falls back to plain term dates when the
// registrar has nothing for the term.
export function termAcademics(evs: AcalEvent[], ts: string, te: string): TermAcademics {
  const res: TermAcademics = { ts, te, mid: midpoint(ts, te), noClass: [], classEnd: te, half1End: null, half2Start: null, half2End: null, has: false };
  let lastInstr: string | null = null;
  for (const ev of evs || []) {
    const r = acalRange(ev); if (!r) continue;
    if (r.end < ts || r.start > te) continue;
    res.has = true;
    const title = ev.title || "";
    if (acalNoClass(title)) res.noClass.push({ start: r.start, end: r.end, title });
    if (/last day of instruction/i.test(title)) {
      if (/7\s*week\s*1/i.test(title)) res.half1End = r.end;
      else if (/7\s*week\s*2/i.test(title)) res.half2End = r.end;
      else if (!/7\s*week/i.test(title)) { if (!lastInstr || r.end > lastInstr) lastInstr = r.end; }
    }
    if (/7\s*week\s*2/i.test(title) && /instruction begins/i.test(title)) res.half2Start = r.start;
  }
  if (lastInstr) res.classEnd = lastInstr;
  return res;
}

export function noClassOn(day: string, ac: TermAcademics) {
  return ac.noClass.find((iv) => day >= iv.start && day <= iv.end) || null;
}

// Whether a meeting of this part of term ("full", "1", "2") runs on the day,
// before no-class days are applied. Same rule as the app's meetingActiveOn.
export function meetingActiveOn(part: string, day: string, ac: TermAcademics) {
  if (day < ac.ts || day > ac.classEnd) return false;
  if (part === "1") return day <= (ac.half1End || ac.mid);
  if (part === "2") return day >= (ac.half2Start || ac.mid) && day <= (ac.half2End || ac.classEnd);
  return true;
}
