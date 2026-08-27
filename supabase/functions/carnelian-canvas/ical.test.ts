// Run: node --test supabase/functions/carnelian/ical.test.ts
// (Node 24 executes .ts via type-stripping; the module is isomorphic.)
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  unfoldIcal, parseVEvents, icalDateToET, normCode, courseKey, courseKeys, guessKind, cleanSummary,
} from "./ical.ts";

test("unfoldIcal splices folded continuation lines", () => {
  // RFC 5545 folds with CRLF + exactly one space/tab; that whitespace is removed.
  assert.equal(unfoldIcal("SUMMARY:Long\r\n wrapped"), "SUMMARY:Longwrapped");
});

test("cleanSummary unescapes and strips a trailing [course tag]", () => {
  assert.equal(cleanSummary("Case Write-up 3\\, part 2 [FA26-REAL-6640-001]"), "Case Write-up 3, part 2");
});

test("icalDateToET: UTC 11:59pm EDT lands on the prior local day", () => {
  // 2026-08-28 03:59:59 UTC == 2026-08-27 23:59 America/New_York (EDT, -4)
  assert.deepEqual(icalDateToET(":20260828T035959Z"), { due_on: "2026-08-27", due_time: "23:59" });
});

test("icalDateToET: UTC in January uses EST (-5)", () => {
  // 2027-01-15 04:59:59 UTC == 2027-01-14 23:59 America/New_York (EST, -5)
  assert.deepEqual(icalDateToET(":20270115T045959Z"), { due_on: "2027-01-14", due_time: "23:59" });
});

test("icalDateToET: VALUE=DATE all-day → date only, no time", () => {
  assert.deepEqual(icalDateToET(";VALUE=DATE:20260828"), { due_on: "2026-08-28", due_time: null });
});

test("icalDateToET: TZID wall-clock taken as-is", () => {
  assert.deepEqual(icalDateToET(";TZID=America/New_York:20260828T133000"), { due_on: "2026-08-28", due_time: "13:30" });
});

test("parseVEvents returns each event with its uid + summary", () => {
  const ics = [
    "BEGIN:VCALENDAR",
    "BEGIN:VEVENT",
    "UID:event-a@instructure.com",
    "SUMMARY:Quiz 3 [FA26-REAL-6101]",
    "DTSTART:20260901T035959Z",
    "END:VEVENT",
    "BEGIN:VEVENT",
    "UID:event-b@instructure.com",
    "SUMMARY:Case Write-up 4",
    "DTSTART;VALUE=DATE:20260905",
    "END:VEVENT",
    "END:VCALENDAR",
  ].join("\r\n");
  const evs = parseVEvents(ics);
  assert.equal(evs.length, 2);
  assert.equal(evs[0].uid, "event-a@instructure.com");
  assert.equal(evs[0].summary, "Quiz 3 [FA26-REAL-6101]");
  assert.equal(evs[0].dtstart, ":20260901T035959Z");
  assert.equal(evs[1].dtstart, ";VALUE=DATE:20260905");
});

test("courseKey extracts SUBJECT+NUMBER, ignoring term tokens", () => {
  assert.equal(courseKey("Quiz 3 [FA26-REAL-6640-001]"), "REAL6640");
  assert.equal(courseKey("HADM 6205 midterm"), "HADM6205");
  assert.equal(courseKey("Assignment (REAL 6101) 2026FA"), "REAL6101");
  assert.equal(courseKey("no code here"), "");
});

test("courseKeys returns every code in a cross-listed tag", () => {
  assert.deepEqual(courseKeys("Assignment 01 [CEE5950/ENMGT5950/REAL5950]"), ["CEE5950", "ENMGT5950", "REAL5950"]);
  assert.deepEqual(courseKeys("Quiz 3 [FA26-REAL-6640-001]"), ["REAL6640"]);
  assert.deepEqual(courseKeys("Career Fair [Toolkit]"), []);
});

test("normCode strips separators", () => {
  assert.equal(normCode("REAL 6640"), "REAL6640");
});

test("guessKind maps keywords to the app's kinds", () => {
  assert.equal(guessKind("Quiz 3"), "quiz");
  assert.equal(guessKind("Final Exam"), "exam");
  assert.equal(guessKind("Midterm"), "exam");
  assert.equal(guessKind("Problem Set 2"), "problem_set");
  assert.equal(guessKind("Reading response"), "reading");
  assert.equal(guessKind("Case Write-up"), "assignment");
});
