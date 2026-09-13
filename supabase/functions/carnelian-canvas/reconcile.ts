export type CanvasIncoming = {
  uid: string;
  enrollment_id: number;
  title: string;
  due_on: string | null;
  due_time: string | null;
  url: string | null;
};

type Change = { from: unknown; to: unknown };
export type CanvasChanges = Record<string, Change>;

const minute = (v: unknown) => v ? String(v).slice(0, 5) : null;
const plainDate = (v: unknown) => v ? String(v).slice(0, 10) : null;

function changed(changes: CanvasChanges, key: string, from: unknown, to: unknown) {
  if (from === to) return;
  const prior = changes[key];
  changes[key] = { from: prior ? prior.from : from, to };
  if (changes[key].from === changes[key].to) delete changes[key];
}

// Produces only Canvas-owned fields. Carnelian customization fields are absent
// from this patch by construction, so a source revision cannot overwrite them.
export function reconcileCanvasSource(existing: any, incoming: CanvasIncoming, now: string) {
  const hasSnapshot = !!(existing.canvas_title || existing.canvas_due_on || existing.canvas_due_time || existing.canvas_url);
  const changes: CanvasChanges = { ...(existing.canvas_changes || {}) };
  const oldTitle = existing.canvas_title ?? null;
  const oldDate = plainDate(existing.canvas_due_on);
  const oldTime = minute(existing.canvas_due_time);
  const oldUrl = existing.canvas_url ?? null;
  const nextDate = plainDate(incoming.due_on);
  const nextTime = minute(incoming.due_time);
  const sourceChanged = !!existing.canvas_removed_at || (hasSnapshot && (
    oldTitle !== incoming.title || oldDate !== nextDate || oldTime !== nextTime || oldUrl !== incoming.url
  ));

  if (hasSnapshot) {
    changed(changes, "title", oldTitle, incoming.title);
    changed(changes, "due_on", oldDate, nextDate);
    changed(changes, "due_time", oldTime, nextTime);
    changed(changes, "url", oldUrl, incoming.url);
  }
  if (existing.canvas_removed_at) changed(changes, "removed", true, false);

  const hasNewChange = JSON.stringify(changes) !== JSON.stringify(existing.canvas_changes || {});
  const hasAnyChange = Object.keys(changes).length > 0;
  return {
    source_changed: sourceChanged,
    enrollment_id: incoming.enrollment_id,
    due_on: nextDate,
    due_time: nextTime,
    canvas_title: incoming.title,
    canvas_due_on: nextDate,
    canvas_due_time: nextTime,
    canvas_url: incoming.url,
    canvas_last_seen_at: now,
    canvas_removed_at: null,
    canvas_missing_count: 0,
    canvas_changes: changes,
    canvas_changed_at: hasAnyChange ? (hasNewChange ? now : (existing.canvas_changed_at ?? now)) : null,
  };
}

// Two consecutive healthy feed snapshots must omit a linked item before it is
// marked removed. A transient empty/partial response therefore cannot erase it.
export function markCanvasMissing(existing: any, now: string, confirmed = false) {
  const missing = confirmed ? 2 : Number(existing.canvas_missing_count || 0) + 1;
  const changes: CanvasChanges = { ...(existing.canvas_changes || {}) };
  let removedAt = existing.canvas_removed_at ?? null;
  let changedAt = existing.canvas_changed_at ?? null;
  if (missing >= 2 && !removedAt) {
    changed(changes, "removed", false, true);
    removedAt = now;
    changedAt = now;
  }
  return {
    canvas_missing_count: missing,
    canvas_removed_at: removedAt,
    canvas_changes: changes,
    canvas_changed_at: changedAt,
  };
}
