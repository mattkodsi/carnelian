-- Split the A&S BA credit requirement into two clear, honest rows.
--
-- Before: a single "Total credits" (120, scope=all) with alsoRequire=[as-ascred].
-- Its own bar read 122.5/120 = full green even though the >=100-in-A&S floor wasn't met,
-- so the degree looked credit-complete when it wasn't. The gate (alsoRequire) only added a
-- footnote; the headline still said done.
--
-- After: two independent required rows that sum to 120 —
--   as-ascred "Arts & Sciences credits" (100, scope=as)   the floor; must be met on its own
--   as-total  "Additional credits"       (20,  scope=all)  the credits BEYOND the 100th
--                                                           (spec.creditFloor=100, capped at 20)
-- The floor is now its own visible, unmet-until-earned requirement, and completion is gated
-- naturally by that row being required — so alsoRequire is dropped.
--
-- Paired with two index.html engine changes (no schema impact):
--   * scope="as"/"all" now honor the in_as flag over the term's career, so an undergrad A&S
--     course taken during a grad (Baker) term counts toward A&S and the undergrad total, and
--     shows as blue in-progress instead of being silently dropped.
--   * spec.creditFloor subtracts the first N credits before measuring this bucket, so the
--     done/in-progress/planned split (and bar3) stays correct for "Additional credits".
--
-- The dashboard "Undergrad Credits x / 120" target is now derived as
-- as-ascred.need (100) + as-total.need (20), keeping a single source of truth.

update carnelian.requirements
  set name = 'Arts & Sciences credits', sort = 1
  where id = 'as-ascred';

update carnelian.requirements
  set name = 'Additional credits', sort = 2,
      spec = '{"need":{"n":20,"type":"credits"},"match":{"scope":"all"},"creditFloor":100,"short":"additional credits"}'::jsonb
  where id = 'as-total';
