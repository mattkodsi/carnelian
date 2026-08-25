-- Google Calendar "academic dates" layer (Phase 2): a second, independently toggle-able
-- Google calendar for Cornell academic dates, kept separate from the class calendar.
-- Applied to the live DB on 2026-08-25 via the Supabase MCP.

alter table carnelian.gcal_config
  add column if not exists calendar_academic text,
  add column if not exists sync_academic boolean not null default false;

-- Per-event mapping for academic all-day events (mirrors gcal_events for classes).
create table if not exists carnelian.gcal_academic (
  akey text primary key,   -- sha256(month|date|title) slice; stable per registrar event
  event_id text,           -- Google event id
  sig text                 -- change-detection signature
);
