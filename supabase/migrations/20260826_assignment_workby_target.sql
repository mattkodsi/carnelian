-- Work-by target: an optional personal "act on it by" moment, distinct from the real deadline
-- (due_on/due_time). The schedule places a deadline on its target day/time when set, else the deadline.
alter table carnelian.assignments
  add column if not exists target_on   date,
  add column if not exists target_time time without time zone;
