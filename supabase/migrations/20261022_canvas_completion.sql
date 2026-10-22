-- Canvas submissions and check-offs, reported by the local canvas-agent job.
-- Kept apart from Matt's own check mark (assignments.done): an item counts as
-- done when any of the three is set, and Canvas clears its flags on reversal.
begin;
alter table carnelian.assignments add column if not exists canvas_submitted_at timestamptz;
alter table carnelian.assignments add column if not exists canvas_marked_done_at timestamptz;
alter table carnelian.canvas_config add column if not exists completion_secret text;
alter table carnelian.canvas_config add column if not exists completion_synced_at timestamptz;
alter table carnelian.canvas_config add column if not exists completion_result jsonb;
-- The job's own secret (stays server-side and in the job's local config; never committed).
update carnelian.canvas_config
  set completion_secret = replace(gen_random_uuid()::text,'-','') || replace(gen_random_uuid()::text,'-','')
  where id = 1 and completion_secret is null;
commit;
