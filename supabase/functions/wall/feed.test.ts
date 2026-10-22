// Scenario tests for the TV wall feed. Run: node --test supabase/functions/wall/feed.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildFeed } from "./feed.ts";
import { ACAL, TERMS, ENR, asg } from "./fixtures.ts";

const acad = { events: ACAL, ok: true, fetchedAt: "2026-10-22T04:00:00.000Z" };
const feed = (now: string, assignments: any[] = [], enrollments = ENR) =>
  buildFeed({ now: new Date(now), assignments, enrollments, terms: TERMS, academic: acad });
const NOON_OCT22 = "2026-10-22T16:00:00Z";

test("a deadline with no time is due at 11:59 PM Eastern and stays all-day", () => {
  const [d] = feed(NOON_OCT22, [asg({ due_on: "2026-10-23" })]).deadlines;
  assert.equal(d.dueISO, "2026-10-24T03:59:00.000Z");
  assert.equal(d.allDay, true);
  assert.equal(d.timeTBA, false);
});

test("an assessment with no time takes its course's class period that day", () => {
  const [d] = feed(NOON_OCT22, [asg({ kind: "quiz", due_on: "2026-10-27" })]).deadlines;
  assert.equal(d.timeFromClass, true);
  assert.equal(d.allDay, false);
  assert.equal(d.dueISO, "2026-10-27T12:40:00.000Z");
  assert.equal(d.endISO, "2026-10-27T13:55:00.000Z");
  assert.equal(d.durationMin, 75);
});

test("an assessment with no time on a day without class shows Time TBA", () => {
  const [d] = feed(NOON_OCT22, [asg({ kind: "exam", due_on: "2026-10-26" })]).deadlines;
  assert.equal(d.timeTBA, true);
  assert.equal(d.allDay, true);
  assert.equal(d.endISO, null);
});

test("a timed assessment gets an end time from its length, or 30 minutes", () => {
  const f = feed(NOON_OCT22, [
    asg({ id: 1, kind: "exam", due_on: "2026-12-17", due_time: "09:00:00", duration_min: 75 }),
    asg({ id: 2, kind: "quiz", due_on: "2026-11-03", due_time: "14:55:00" }),
  ]);
  const exam = f.deadlines.find((d: any) => d.id === 1), quiz = f.deadlines.find((d: any) => d.id === 2);
  assert.equal(exam.endISO, "2026-12-17T15:15:00.000Z");
  assert.equal(quiz.durationMin, 30);
  assert.equal(quiz.endISO, "2026-11-03T20:25:00.000Z");
  assert.deepEqual(f.exams.map((d: any) => d.id), [1]);
});

test("a pending item is included and marked pending", () => {
  const [d] = feed(NOON_OCT22, [asg({ status: "pending" })]).deadlines;
  assert.equal(d.pending, true);
});

test("an item submitted or checked off in Canvas, or checked off by Matt, is left out", () => {
  const f = feed(NOON_OCT22, [asg({ id: 1 }), asg({ id: 2, canvas_submitted_at: "2026-10-21T20:00:00Z" }),
    asg({ id: 3, canvas_marked_done_at: "2026-10-21T20:00:00Z" }), asg({ id: 4, done: true })]);
  assert.deepEqual(f.deadlines.map((d: any) => d.id), [1]);
});

test("a TA course's exams stay off the TV, but its other deadlines show", () => {
  const f = feed(NOON_OCT22, [
    asg({ id: 1, kind: "exam", due_on: "2026-10-28", due_time: "10:10:00", duration_min: 75, enrollment_id: 110 }),
    asg({ id: 2, kind: "quiz", due_on: "2026-10-28", enrollment_id: 109 }),
    asg({ id: 3, kind: "homework", due_on: "2026-10-25", due_time: "23:30:00", enrollment_id: 109 }),
    asg({ id: 4, kind: "exam", due_on: "2026-10-29", due_time: "08:40:00", enrollment_id: 86 }),
  ]);
  assert.deepEqual(f.deadlines.map((d: any) => d.id).sort(), [3, 4]);
  assert.deepEqual(f.exams.map((d: any) => d.id), [4]);
  assert.equal(f.deadlines.find((d: any) => d.id === 3).role, "ta_paid");
});

test("a work-by target sets workByISO without moving the due time", () => {
  const [d] = feed(NOON_OCT22, [asg({ due_on: "2026-11-10", due_time: "08:00:00", target_on: "2026-11-12", target_time: "13:20:00" })]).deadlines;
  assert.equal(d.dueISO, "2026-11-10T13:00:00.000Z");
  assert.equal(d.workByISO, "2026-11-12T18:20:00.000Z");
});

test("the title is the stored name, with the app's fallback when it is empty", () => {
  const f = feed(NOON_OCT22, [asg({ id: 1, name: "Homework: High-Density Slide", override_title: "Old title" }), asg({ id: 2, name: "", series: "Tarea", number: 2, kind: "homework" })]);
  assert.deepEqual(f.deadlines.map((d: any) => d.title).sort(), ["Homework: High-Density Slide", "Tarea 2"]);
});

test("every item is included even past 60", () => {
  const many = Array.from({ length: 75 }, (_, i) => asg({ id: i + 1, name: `Item ${i + 1}` }));
  assert.equal(feed(NOON_OCT22, many).deadlines.length, 75);
});

test("a break day has no sessions and one no-class notice", () => {
  const f = feed("2026-11-24T16:00:00Z");
  assert.equal(f.events.filter((e: any) => e.startISO.startsWith("2026-11-26")).length, 0);
  const n = f.academic.filter((a: any) => a.title.startsWith("Thanksgiving"));
  assert.equal(n.length, 1);
  assert.equal(n[0].noClass, true);
  assert.equal(f.events.some((e: any) => e.code === "REAL 6101" && e.startISO.startsWith("2026-11-24")), true);
});

test("other cohorts' notices are left out", () => {
  const f = feed("2026-11-16T16:00:00Z");
  assert.equal(f.academic.some((a: any) => /Sophomores/.test(a.title)), false);
});

test("no sessions after the last day of instruction, and the TV is told why", () => {
  const f = feed("2026-12-08T16:00:00Z");
  assert.equal(f.events.filter((e: any) => e.code !== "REAL 7000").length, 0);
  assert.equal(f.academic.some((a: any) => a.noClass && a.startDate <= "2026-12-11" && a.endDate >= "2026-12-11"), true);
  assert.equal(f.academic.find((a: any) => /Study days/.test(a.title)).noClass, true);
});

test("half-term courses follow the registrar's 7-week dates", () => {
  const oct = feed("2026-10-05T16:00:00Z");        // Mon Oct 5 to Mon Oct 12
  assert.equal(oct.events.some((e: any) => e.code === "REAL 5560" && e.startISO.startsWith("2026-10-07")), true);
  assert.equal(oct.events.some((e: any) => e.code === "REAL 5561"), false);
  const half2 = feed("2026-10-14T16:00:00Z");      // Wed Oct 14 to Wed Oct 21
  assert.equal(half2.events.some((e: any) => e.code === "REAL 5561" && e.startISO.startsWith("2026-10-14")), true);
  assert.equal(half2.events.some((e: any) => e.code === "REAL 5560"), false);
  const dec = feed("2026-12-02T16:00:00Z");        // second half ends Fri Dec 4
  assert.equal(dec.events.some((e: any) => e.code === "REAL 5561" && e.startISO.startsWith("2026-12-02")), true);
  assert.equal(dec.events.some((e: any) => e.code === "REAL 5561" && e.startISO.startsWith("2026-12-07")), false);
});

test("wishlist courses are left out of class sessions", () => {
  assert.equal(feed(NOON_OCT22).events.some((e: any) => e.code === "GOVT 9999"), false);
});

test("a TA session shows only when nothing else overlaps it", () => {
  const f = feed("2026-10-26T12:00:00Z");          // Monday: REAL 5561 meets 10:10, same as HADM section 001
  const hadm = f.events.filter((e: any) => e.code === "HADM 6205" && e.startISO.startsWith("2026-10-26"));
  assert.deepEqual(hadm.map((e: any) => e.section), ["002"]);
  assert.equal(hadm[0].subordinate, true);
  assert.equal(hadm[0].role, "ta_paid");
  const blocked = feed("2026-10-26T12:00:00Z", [asg({ kind: "exam", due_on: "2026-10-26", due_time: "15:00:00", duration_min: 60 })]);
  assert.equal(blocked.events.some((e: any) => e.code === "HADM 6205" && e.startISO.startsWith("2026-10-26")), false);
});

test("two sections of one course share a color, and pins match the app", () => {
  const f = feed("2026-10-26T12:00:00Z");
  const hadm = f.events.filter((e: any) => e.code === "HADM 6205");
  assert.equal(new Set(hadm.map((e: any) => e.color)).size, 1);
  assert.equal(hadm[0].color, "#64748B");
  assert.equal(f.events.find((e: any) => e.code === "REAL 5561").color, "#9C36B5");
});

test("a weekend meeting is included", () => {
  assert.equal(feed(NOON_OCT22).events.some((e: any) => e.code === "REAL 7000" && e.startISO.startsWith("2026-10-24")), true);
});

test("a deleted enrollment's sessions and deadlines disappear", () => {
  const f = feed(NOON_OCT22, [asg({ enrollment_id: 999 })], ENR.filter((e) => e.id !== 86));
  assert.equal(f.events.some((e: any) => e.code === "REAL 6101"), false);
  assert.equal(f.deadlines[0].course, null);
});

test("times stay right across the Nov 1 daylight saving change", () => {
  const f = feed("2026-10-31T04:30:00Z", [         // 12:30 AM EDT, Saturday Oct 31
    asg({ id: 1, due_on: "2026-10-31", due_time: "00:00:00" }),
    asg({ id: 2, due_on: "2026-11-02" }),
  ]);
  assert.equal(f.deadlines.find((d: any) => d.id === 1).dueISO, "2026-10-31T04:00:00.000Z");
  assert.equal(f.deadlines.find((d: any) => d.id === 2).dueISO, "2026-11-03T04:59:00.000Z");
  const days = [...new Set(f.events.map((e: any) => e.startISO.slice(0, 10)))];
  assert.equal(new Set(days).size, days.length);
  assert.equal(f.events.some((e: any) => e.code === "REAL 6101" && e.startISO === "2026-11-03T13:40:00.000Z"), true);
});

test("a failed registrar refresh is reported", () => {
  const f = buildFeed({ now: new Date(NOON_OCT22), assignments: [], enrollments: ENR, terms: TERMS, academic: { events: ACAL, ok: false, fetchedAt: "2026-10-20T04:00:00.000Z" } });
  assert.deepEqual(f.academicStatus, { ok: false, fetchedAt: "2026-10-20T04:00:00.000Z" });
  assert.equal(f.canvasCompletionSyncedAt, null);
  assert.equal(f.contract, 2);
});
