-- Keep Canvas's source state beside the customizable Carnelian assignment.
-- The immutable ext_uid remains the one-to-one link; these columns track what
-- Canvas last said without overwriting Carnelian titles, targets, or filing.
alter table carnelian.assignments
  add column if not exists canvas_title         text,
  add column if not exists canvas_due_on        date,
  add column if not exists canvas_due_time      time without time zone,
  add column if not exists canvas_url           text,
  add column if not exists canvas_last_seen_at  timestamptz,
  add column if not exists canvas_removed_at    timestamptz,
  add column if not exists canvas_changed_at    timestamptz,
  add column if not exists canvas_missing_count integer not null default 0,
  add column if not exists canvas_changes       jsonb not null default '{}'::jsonb;

alter table carnelian.assignments
  drop constraint if exists assignments_canvas_missing_count_chk,
  add constraint assignments_canvas_missing_count_chk check (canvas_missing_count >= 0),
  drop constraint if exists assignments_canvas_changes_object_chk,
  add constraint assignments_canvas_changes_object_chk check (jsonb_typeof(canvas_changes) = 'object');
