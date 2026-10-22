// Course colors, assignment kinds, and roles: the same rules the app uses in
// index.html (SCHED_COLORS, COURSE_PIN, assignCourseColors, ASG_KINDS, roleOf).
// Pure code shared by edge functions and runnable under `node --test`.

export const SCHED_COLORS = ["#1971C2", "#E8590C", "#099268", "#C2255C", "#2B8A3E", "#7048E8", "#A88200", "#E03131", "#9C36B5", "#4263EB", "#A0522D", "#64748B"];
export const COURSE_PIN: Record<string, number> = { REAL6595: 0, REAL6640: 7, ASIAN4377: 3, REAL5560: 5, REAL5561: 8, HADM6205: 11, REAL6901: 9, GOVT1109: 4, INDO1100: 6 };
const pinKey = (code: string) => String(code || "").toUpperCase().replace(/\s+/g, "");

// Pinned courses take their pin; every other course fills the unpinned palette
// slots in list order, so no auto-assigned course collides with a pin. The app
// passes one term's non-wishlist enrollments ordered by id.
export function assignCourseColors(list: { id: number; code?: string | null }[]): Record<string, number> {
  const map: Record<string, number> = {}; const pinned = new Set<number>();
  for (const e of list) { const p = COURSE_PIN[pinKey(e.code || "")]; if (p != null) pinned.add(p); }
  const avail = SCHED_COLORS.map((_, i) => i).filter((i) => !pinned.has(i)); let ai = 0;
  for (const e of list) {
    const k = e.code || ("#" + e.id); if (map[k] != null) continue;
    const p = COURSE_PIN[pinKey(e.code || "")];
    map[k] = (p != null) ? p : (avail.length ? avail[ai++ % avail.length] : (ai++ % SCHED_COLORS.length));
  }
  return map;
}

export const KIND_LABEL: Record<string, string> = {
  exam: "Exam", quiz: "Quiz", homework: "Homework", assignment: "Assignment", problem_set: "Problem Set",
  paper: "Paper", presentation: "Presentation", project: "Project", reading: "Reading", draft: "Draft",
  survey: "Survey", other: "Other",
};
export const kindLabel = (k: string | null | undefined) => KIND_LABEL[k || ""] || "Other";

// Timed kinds are assessments: they occupy time rather than mark a deadline.
export const ASSESSMENT_KINDS = new Set(["exam", "quiz", "presentation"]);
// The app's schedule grid draws an assessment with no length as 30 minutes.
export const DEFAULT_ASSESSMENT_MIN = 30;

// The app's asgTitle: the stored name, else a title composed from its parts.
export function assignmentTitle(a: any) {
  const name = String(a.name || "").trim(); if (name) return name;
  const ov = String(a.override_title || "").trim(); if (ov) return ov;
  const lead = String(a.series || "").trim() || kindLabel(a.kind);
  const num = a.number != null && a.number !== "" ? " " + a.number : "";
  const desc = String(a.descriptor || "").trim() ? ": " + String(a.descriptor).trim() : "";
  return lead + num + desc;
}

export const roleOf = (e: { role?: string | null }) => e.role || "course";
export const isTA = (role: string) => role === "ta_paid" || role === "ta_credit";

// Matt's extra time (settings.extra_time, e.g. 1.5) stretches the standard length of his
// exams and quizzes. A TA course's exams are the students', and an item whose time is
// already his own slot opts out (assignments.extra_time = false).
export const EXTRA_TIME_KINDS = new Set(["exam", "quiz"]);
export function extraTimeFactor(a: { kind?: string | null; extra_time?: boolean | null }, role: string, setting: unknown) {
  const f = Number(setting);
  return f > 1 && f <= 4 && EXTRA_TIME_KINDS.has(a.kind || "") && !isTA(role) && a.extra_time !== false ? f : 1;
}
