// Fall 2026 fixtures shared by the feed scenario tests and the app parity tests.

// Registrar entries as parseAcademicCalendar returns them.
export const ACAL = [
  { month: "September 2026", date: "Sep 7", time: "", title: "Labor Day/Holiday/No classes" },
  { month: "October 2026", date: "Oct 9", time: "", title: "Fall 2026: Last day of instruction for classes in 7 week 1 session" },
  { month: "October 2026", date: "Oct 10 – Oct 13", time: "", title: "Fall Break/No classes" },
  { month: "October 2026", date: "Oct 14", time: "", title: "Fall 2026: 7 week 2 session instruction begins" },
  { month: "November 2026", date: "Nov 17 – Nov 19", time: "", title: "Spring 2027: Enrollment begins for Sophomores and Vet Med second-years" },
  { month: "November 2026", date: "Nov 25 – Nov 29", time: "", title: "Thanksgiving Break/No classes" },
  { month: "December 2026", date: "Dec 4", time: "", title: "Fall 2026: Last day of instruction for classes in 7 week 2 session" },
  { month: "December 2026", date: "Dec 7", time: "", title: "Fall 2026: Last day of instruction for classes in first-year writing seminar, project session full, and regular session" },
  { month: "December 2026", date: "Dec 8 – Dec 10", time: "", title: "Fall 2026: Study days" },
];

export const TERMS = [{ id: "by1fa", starts_on: "2026-08-24", ends_on: "2026-12-18" }];

export const meet = (days: string[], start: string, end: string, extra: any = {}) =>
  ({ days, start, end, part: "full", section: "001", location: "Sibley Hall 157", component: "LEC", ...extra });

export const ENR = [
  { id: 83, code: "REAL 5560", title: "Creating the Built Environment", term_id: "by1fa", status: "in_progress", role: null, meetings: [meet(["M", "W"], "10:10", "11:25", { part: "1" })] },
  { id: 86, code: "REAL 6101", title: "Urban Economics", term_id: "by1fa", status: "in_progress", role: null, meetings: [meet(["T", "R"], "08:40", "09:55")],
    no_class: [{ date: "2026-11-05", reason: "CREC conference" }, { date: "2026-11-04", reason: "not a class day" }] },
  { id: 87, code: "REAL 5561", title: "Innovation and Strategy", term_id: "by1fa", status: "in_progress", role: null, meetings: [meet(["M", "W"], "10:10", "11:25", { part: "2" })] },
  { id: 109, code: "HADM 6205", title: "RE Financial Modeling", term_id: "by1fa", status: "in_progress", role: "ta_paid", meetings: [meet(["M", "W"], "14:55", "16:10", { section: "002" })] },
  { id: 110, code: "HADM 6205", title: "RE Financial Modeling", term_id: "by1fa", status: "in_progress", role: "ta_paid", meetings: [meet(["M", "W"], "10:10", "11:25")] },
  { id: 115, code: "SPAN 1502", title: "Conversational Spanish", term_id: "by1fa", status: "in_progress", role: null, meetings: [meet(["T"], "10:10", "11:50", { part: "2", section: "101" })] },
  { id: 120, code: "GOVT 9999", title: "Someday Maybe", term_id: "by1fa", status: "wishlist", role: null, meetings: [meet(["M"], "12:00", "13:00")] },
  { id: 121, code: "REAL 7000", title: "Saturday Studio", term_id: "by1fa", status: "in_progress", role: null, meetings: [meet(["S"], "09:00", "12:00")] },
];

export const asg = (o: any) => ({
  id: 1, name: "Item", kind: "assignment", due_on: "2026-10-22", due_time: null, duration_min: null,
  target_on: null, target_time: null, status: "active", source: "manual", canvas_url: null, enrollment_id: 86, done: false, ...o,
});
