import test from "node:test";
import assert from "node:assert/strict";
import { reconcileCanvasSource, markCanvasMissing, agedOutOfFeed, canvasAssignmentId, completionPatch } from "./reconcile.ts";

const linked = {
  id: 17,
  enrollment_id: 91,
  name: "My Standardized Memo",
  override_title: "Memo 2: Market Analysis",
  due_on: "2026-09-15",
  due_time: "08:00",
  target_on: "2026-09-14",
  target_time: "23:59",
  ext_uid: "event-assignment-42",
  canvas_title: "Memo 2",
  canvas_due_on: "2026-09-15",
  canvas_due_time: "08:00",
  canvas_url: "https://canvas.example/assignments/42",
  canvas_removed_at: null,
  canvas_missing_count: 0,
  canvas_changes: {},
};

test("Canvas title revisions are marked without replacing the Carnelian title", () => {
  const patch = reconcileCanvasSource(linked, {
    uid: linked.ext_uid,
    enrollment_id: 91,
    title: "Memo 2 — Revised Instructions",
    due_on: "2026-09-15",
    due_time: "08:00",
    url: linked.canvas_url,
  }, "2026-09-13T15:00:00Z");

  assert.equal(patch.canvas_title, "Memo 2 — Revised Instructions");
  assert.deepEqual(patch.canvas_changes.title, { from: "Memo 2", to: "Memo 2 — Revised Instructions" });
  assert.equal(patch.source_changed, true);
  assert.equal("name" in patch, false);
  assert.equal("override_title" in patch, false);
});

test("Canvas deadline revisions replace the real deadline but preserve the work-by target", () => {
  const patch = reconcileCanvasSource(linked, {
    uid: linked.ext_uid,
    enrollment_id: 91,
    title: linked.canvas_title,
    due_on: "2026-09-17",
    due_time: "10:30",
    url: linked.canvas_url,
  }, "2026-09-13T15:00:00Z");

  assert.equal(patch.due_on, "2026-09-17");
  assert.equal(patch.due_time, "10:30");
  assert.deepEqual(patch.canvas_changes.due_on, { from: "2026-09-15", to: "2026-09-17" });
  assert.deepEqual(patch.canvas_changes.due_time, { from: "08:00", to: "10:30" });
  assert.equal("target_on" in patch, false);
  assert.equal("target_time" in patch, false);
});

test("first source snapshot backfills provenance without reporting a false revision", () => {
  const legacy = { ...linked, canvas_title: null, canvas_due_on: null, canvas_due_time: null, canvas_url: null };
  const patch = reconcileCanvasSource(legacy, {
    uid: linked.ext_uid,
    enrollment_id: 91,
    title: "Memo 2",
    due_on: "2026-09-15",
    due_time: "08:00",
    url: linked.canvas_url,
  }, "2026-09-13T15:00:00Z");

  assert.deepEqual(patch.canvas_changes, {});
  assert.equal(patch.canvas_changed_at, null);
  assert.equal(patch.source_changed, false);
});

test("a missing Canvas assignment is marked removed only after two healthy misses", () => {
  const first = markCanvasMissing(linked, "2026-09-13T15:00:00Z");
  assert.equal(first.canvas_missing_count, 1);
  assert.equal(first.canvas_removed_at, null);

  const second = markCanvasMissing({ ...linked, ...first }, "2026-09-14T15:00:00Z");
  assert.equal(second.canvas_missing_count, 2);
  assert.equal(second.canvas_removed_at, "2026-09-14T15:00:00Z");
  assert.deepEqual(second.canvas_changes.removed, { from: false, to: true });
});

test("an explicitly cancelled Canvas assignment is marked removed immediately", () => {
  const patch = markCanvasMissing(linked, "2026-09-13T15:00:00Z", true);
  assert.equal(patch.canvas_missing_count, 2);
  assert.equal(patch.canvas_removed_at, "2026-09-13T15:00:00Z");
});

test("a removed assignment that returns is restored and marked", () => {
  const removed = { ...linked, canvas_removed_at: "2026-09-12T15:00:00Z", canvas_missing_count: 2 };
  const patch = reconcileCanvasSource(removed, {
    uid: linked.ext_uid,
    enrollment_id: 91,
    title: linked.canvas_title,
    due_on: linked.canvas_due_on,
    due_time: linked.canvas_due_time,
    url: linked.canvas_url,
  }, "2026-09-13T15:00:00Z");

  assert.equal(patch.canvas_removed_at, null);
  assert.equal(patch.canvas_missing_count, 0);
  assert.deepEqual(patch.canvas_changes.removed, { from: true, to: false });
});

test("an assignment due before the feed's 30-day lookback has aged out, not been removed", () => {
  const now = "2026-10-22T05:30:00Z";
  assert.equal(agedOutOfFeed("2026-08-27", now), true);
  assert.equal(agedOutOfFeed("2026-09-20", now), true);
  assert.equal(agedOutOfFeed("2026-09-26", now), false);
  assert.equal(agedOutOfFeed("2026-12-03", now), false);
});

test("an undated assignment never counts as aged out", () => {
  assert.equal(agedOutOfFeed(null, "2026-10-22T05:30:00Z"), false);
  assert.equal(agedOutOfFeed("", "2026-10-22T05:30:00Z"), false);
});

test("a linked row's Canvas assignment id comes from its UID, or its URL for an override", () => {
  assert.equal(canvasAssignmentId({ ext_uid: "event-assignment-980691" }), 980691);
  assert.equal(canvasAssignmentId({ ext_uid: "event-assignment-override-180320",
    canvas_url: "https://canvas.cornell.edu/calendar?include_contexts=course_91080&month=10&year=2026#assignment_1027763" }), 1027763);
  assert.equal(canvasAssignmentId({ ext_uid: null, canvas_url: null }), null);
});

test("Canvas submission and check-off flags keep their first time and clear when reversed", () => {
  const first = completionPatch({}, { submitted: true, markedComplete: false }, "2026-10-22T10:00:00Z");
  assert.deepEqual(first, { canvas_submitted_at: "2026-10-22T10:00:00Z", canvas_marked_done_at: null });
  const later = completionPatch(first, { submitted: true, markedComplete: true }, "2026-10-22T11:00:00Z");
  assert.deepEqual(later, { canvas_submitted_at: "2026-10-22T10:00:00Z", canvas_marked_done_at: "2026-10-22T11:00:00Z" });
  assert.deepEqual(completionPatch(later, { submitted: false, markedComplete: false }, "2026-10-22T12:00:00Z"),
    { canvas_submitted_at: null, canvas_marked_done_at: null });
});

test("a source revision that returns to its reviewed value clears its marker", () => {
  const revised = { ...linked, canvas_title: "Memo 2 — Revised", canvas_changed_at: "2026-09-12T15:00:00Z",
    canvas_changes: { title: { from: "Memo 2", to: "Memo 2 — Revised" } } };
  const patch = reconcileCanvasSource(revised, {
    uid: linked.ext_uid, enrollment_id: 91, title: "Memo 2",
    due_on: linked.canvas_due_on, due_time: linked.canvas_due_time, url: linked.canvas_url,
  }, "2026-09-13T15:00:00Z");
  assert.deepEqual(patch.canvas_changes, {});
  assert.equal(patch.canvas_changed_at, null);
});
