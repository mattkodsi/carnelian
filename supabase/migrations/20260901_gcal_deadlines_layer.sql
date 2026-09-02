-- Google Calendar "Class deadlines" layer (Phase 3 of the layered-schedule plan): a third, independently
-- toggle-able Google calendar ("Carnelian - Deadlines") holding per-class assignment deadlines. Mirrors
-- the academic layer's shape (a calendar id + an opt-in flag on gcal_config, plus a per-event map table
-- for idempotent reconcile). Timed deadlines become timed events on the grid; all-day ones sit at the top.
alter table carnelian.gcal_config add column if not exists calendar_deadlines text;
alter table carnelian.gcal_config add column if not exists sync_deadlines boolean not null default false;

-- One row per synced deadline. dkey = the assignment id (stable, unique per assignment).
create table if not exists carnelian.gcal_deadlines (
  dkey     text primary key,
  event_id text,
  sig      text
);
