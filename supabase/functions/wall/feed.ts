// Pure builder for the TV wall feed (contract 2). index.ts loads the rows and the
// registrar calendar and calls buildFeed; tests call it with fixtures. Contract 1
// fields keep their meaning; everything else is additive.
import { termAcademics, meetingActiveOn, noClassOn, classMeetingOn, partOfMeeting, acalRange, acalRelevant, acalNoClass, addDays, courseNoClassOn, courseNoClassTitle } from "../_shared/acal.ts";
import { SCHED_COLORS, assignCourseColors, kindLabel, assignmentTitle, ASSESSMENT_KINDS, DEFAULT_ASSESSMENT_MIN, roleOf, isTA, extraTimeFactor } from "../_shared/courses.ts";

export const TZ = "America/New_York";
export const WINDOW_DAYS = 8;
const DOW: Record<string, number> = { U: 0, M: 1, T: 2, W: 3, R: 4, F: 5, S: 6 };

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
export function etToday(instant: Date): string {
  const p = new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(instant);
  const g = (t: string) => p.find((x) => x.type === t)!.value;
  return `${g("year")}-${g("month")}-${g("day")}`;
}
// An Eastern wall-clock date and "HH:MM" as a UTC instant.
function at(day: string, time: string) {
  const [y, mo, d] = day.split("-").map(Number), [h, mi] = time.slice(0, 5).split(":").map(Number);
  return etToISO(y, mo, d, h, mi);
}
const plusMin = (instant: string, min: number) => new Date(Date.parse(instant) + min * 60000).toISOString();
const dowOf = (day: string) => { const [y, mo, d] = day.split("-").map(Number); return new Date(Date.UTC(y, mo - 1, d)).getUTCDay(); };
const minutes = (t: string) => { const [h, m] = t.slice(0, 5).split(":").map(Number); return h * 60 + m; };
const validMeeting = (m: any) => m && Array.isArray(m.days) && m.days.length && /^\d{1,2}:\d{2}/.test(m.start || "") && /^\d{1,2}:\d{2}/.test(m.end || "") && minutes(m.end) > minutes(m.start);
const dateOnly = (v: unknown) => (v ? String(v).slice(0, 10) : "");

export type FeedInput = {
  now: Date;
  assignments: any[];   // not removed from Canvas, due today or later
  enrollments: any[];
  terms: any[];
  academic: { events: any[]; ok: boolean; fetchedAt: string | null };
  canvasCompletionSyncedAt?: string | null;
  extraTime?: number | null;   // app_config.settings.extra_time
};

export function buildFeed(input: FeedInput) {
  const today = etToday(input.now);
  const days = Array.from({ length: WINDOW_DAYS }, (_, i) => addDays(today, i));
  const lastDay = days[days.length - 1];
  const acEvents = input.academic.events || [];
  const termById = new Map(input.terms.map((t: any) => [t.id, t]));
  const enrById = new Map(input.enrollments.map((e: any) => [e.id, e]));
  const enrolled = input.enrollments.filter((e: any) => e.status !== "wishlist").sort((a: any, b: any) => a.id - b.id);

  const acCache = new Map<string, any>();
  const acFor = (termId: string) => {
    if (!acCache.has(termId)) {
      const t: any = termById.get(termId);
      acCache.set(termId, t && t.starts_on && t.ends_on ? termAcademics(acEvents, dateOnly(t.starts_on), dateOnly(t.ends_on)) : null);
    }
    return acCache.get(termId);
  };

  // One color per course within a term, exactly as the app assigns them.
  const colorOf = new Map<number, string>();
  const byTerm = new Map<string, any[]>();
  for (const e of enrolled) { const k = e.term_id || "_"; if (!byTerm.has(k)) byTerm.set(k, []); byTerm.get(k)!.push(e); }
  for (const [, list] of byTerm) {
    const idx = assignCourseColors(list);
    for (const e of list) colorOf.set(e.id, SCHED_COLORS[idx[e.code || ("#" + e.id)] % SCHED_COLORS.length]);
  }

  // Submitting or checking off an item in Canvas removes it, even before the deadline.
  const open = input.assignments.filter((a: any) => !a.done && !a.canvas_submitted_at && !a.canvas_marked_done_at);
  const deadlines = open.map((a: any) => {
    const e: any = enrById.get(a.enrollment_id) || {};
    const role = roleOf(e);
    const assessment = ASSESSMENT_KINDS.has(a.kind);
    const dueDate = dateOnly(a.due_on);
    const dueTime = a.due_time ? String(a.due_time).slice(0, 5) : null;
    const setMin = Number(a.duration_min) > 0 ? Number(a.duration_min) : null;
    const xf = extraTimeFactor(a, role, input.extraTime);
    let dueISO: string, allDay = false, endISO: string | null = null, durationMin: number | null = null;
    let timeFromClass = false, timeTBA = false;
    if (dueTime) {
      dueISO = at(dueDate, dueTime);
      if (assessment) { durationMin = (setMin ?? DEFAULT_ASSESSMENT_MIN) * xf; endISO = plusMin(dueISO, durationMin); }
    } else if (assessment) {
      // Matt's rule: an assessment with no time takes that course's class period (none when
      // the course cancelled that class).
      const m = e.term_id && !courseNoClassOn(e, dueDate) ? classMeetingOn(e.meetings, dueDate, acFor(e.term_id)) : null;
      if (m) {
        dueISO = at(dueDate, m.start); durationMin = (setMin ?? (minutes(m.end) - minutes(m.start))) * xf;
        endISO = plusMin(dueISO, durationMin); timeFromClass = true;
      } else { dueISO = at(dueDate, "23:59"); allDay = true; timeTBA = true; }
    } else { dueISO = at(dueDate, "23:59"); allDay = true; }
    const target = dateOnly(a.target_on);
    return {
      id: a.id, title: assignmentTitle(a) || "Untitled", course: e.code || null, kind: a.kind, status: a.status, allDay, dueISO,
      dueDate, kindLabel: kindLabel(a.kind), assessment, timeTBA, timeFromClass, durationMin, endISO,
      courseTitle: e.title || null, color: colorOf.get(e.id) || null, role, pending: a.status === "pending",
      workByISO: target ? at(target, a.target_time ? String(a.target_time) : "23:59") : null,
      source: a.source || null, canvasUrl: a.canvas_url || null,
    };
  // Matt's call (2026-10-22): a TA course's exams, quizzes, and presentations are the
  // students', so they stay off the TV. Its other deadlines still show.
  }).filter((d: any) => !(d.assessment && isTA(d.role))).sort((x: any, y: any) => (x.dueISO < y.dueISO ? -1 : x.dueISO > y.dueISO ? 1 : x.title.localeCompare(y.title)));
  const exams = deadlines.filter((d: any) => d.kind === "exam");

  let events: any[] = [];
  const activeTerms = new Set<string>();
  for (const day of days) {
    const dow = dowOf(day);
    for (const e of enrolled) {
      const t: any = termById.get(e.term_id);
      if (!t || !t.starts_on || !t.ends_on) continue;
      if (day < dateOnly(t.starts_on) || day > dateOnly(t.ends_on)) continue;
      activeTerms.add(e.term_id);
      const ac = acFor(e.term_id);
      if (noClassOn(day, ac) || courseNoClassOn(e, day)) continue;
      for (const m of e.meetings || []) {
        if (!validMeeting(m) || !m.days.some((d: string) => DOW[d] === dow)) continue;
        if (!meetingActiveOn(partOfMeeting(m), day, ac)) continue;
        const role = roleOf(e);
        events.push({
          title: e.code ? `${e.code} · ${e.title}` : e.title, code: e.code,
          location: m.location || null, component: m.component || null, dest: coordsFor(m.location),
          startISO: at(day, m.start), endISO: at(day, m.end),
          color: colorOf.get(e.id) || null, role, courseTitle: e.title || null, part: partOfMeeting(m), section: m.section || null,
          subordinate: isTA(role), _enr: e.id,
        });
      }
    }
  }
  // Matt attends neither HADM lecture: a TA session shows only when nothing else
  // (another class, or an assessment in a course he takes) overlaps it.
  const busy = [
    ...events.filter((ev) => !isTA(ev.role)).map((ev) => [ev.startISO, ev.endISO]),
    ...deadlines.filter((d: any) => d.endISO && !isTA(d.role)).map((d: any) => [d.dueISO, d.endISO]),
  ];
  events = events.filter((ev) => !isTA(ev.role) || !busy.some(([s, en]) => s < ev.endISO && en > ev.startISO));
  events.sort((a, b) => (a.startISO < b.startISO ? -1 : a.startISO > b.startISO ? 1 : 0));
  for (const ev of events) delete ev._enr;

  // Registrar dates in the window, so the TV can say why a day has no classes.
  const termAcs = [...activeTerms].map((id) => acFor(id)).filter(Boolean);
  const academic: any[] = [];
  for (const ev of acEvents) {
    const r = acalRange(ev); if (!r || r.end < today || r.start > lastDay) continue;
    const title = ev.title || "";
    const afterClasses = termAcs.some((ac: any) => r.start > ac.classEnd && r.start <= ac.te);
    if (!acalNoClass(title) && !acalRelevant(title)) continue;
    academic.push({ title, startDate: r.start, endDate: r.end, noClass: acalNoClass(title) || afterClasses });
  }
  // A course's own cancelled class gets a notice on the day it would have met.
  for (const e of enrolled) {
    const ac = e.term_id ? acFor(e.term_id) : null;
    for (const day of days) {
      const x = courseNoClassOn(e, day);
      if (!x || !ac || !classMeetingOn(e.meetings, day, ac)) continue;
      const title = courseNoClassTitle(e, x);   // two sections of one course share a notice
      if (!academic.some((n) => n.title === title && n.startDate === day)) academic.push({ title, startDate: day, endDate: day, noClass: true, course: e.code || null });
    }
  }
  for (const ac of termAcs) {
    const uncovered = days.filter((d) => d > ac.classEnd && d <= ac.te && !academic.some((n) => n.noClass && d >= n.startDate && d <= n.endDate));
    if (uncovered.length) academic.push({ title: "Classes have ended for the term", startDate: uncovered[0], endDate: uncovered[uncovered.length - 1], noClass: true });
  }
  academic.sort((a, b) => (a.startDate < b.startDate ? -1 : a.startDate > b.startDate ? 1 : 0));

  return {
    ok: true, contract: 2, generatedAt: input.now.toISOString(), tz: TZ,
    counts: { deadlines: deadlines.length, exams: exams.length, events: events.length },
    deadlines, exams, events, academic,
    academicStatus: { ok: input.academic.ok, fetchedAt: input.academic.fetchedAt },
    canvasCompletionSyncedAt: input.canvasCompletionSyncedAt ?? null,
  };
}
