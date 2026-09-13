-- Canvas assignments whose course tag does not map to a Planner enrollment.
-- They remain private and are exposed only through the authenticated Canvas
-- edge function, where they can be filed or deliberately rejected.
create table if not exists carnelian.canvas_unassigned (
  ext_uid text primary key,
  canvas_title text not null,
  canvas_due_on date not null,
  canvas_due_time time without time zone,
  canvas_url text,
  canvas_course_keys text[] not null default '{}',
  canvas_last_seen_at timestamptz not null default now(),
  canvas_removed_at timestamptz,
  canvas_changed_at timestamptz,
  canvas_missing_count integer not null default 0,
  canvas_changes jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  constraint canvas_unassigned_missing_count_chk check (canvas_missing_count >= 0),
  constraint canvas_unassigned_changes_object_chk check (jsonb_typeof(canvas_changes) = 'object')
);
create index if not exists canvas_unassigned_due_idx on carnelian.canvas_unassigned (canvas_due_on, canvas_due_time);
alter table carnelian.canvas_unassigned enable row level security;
revoke all on carnelian.canvas_unassigned from public, anon, authenticated;
