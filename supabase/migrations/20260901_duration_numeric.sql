-- Assignment duration: allow fractional minutes (e.g. 112.5) and any value, not just
-- multiples of 5. The editor input was step="5" (rejecting non-multiples like 112) and
-- saved via parseInt (dropping the .5); the column was integer. Widen it to numeric.
alter table carnelian.assignments alter column duration_min type numeric(6,2);
