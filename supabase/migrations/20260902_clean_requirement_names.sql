-- Remove counts embedded in requirement names that the "x / N" progress header
-- already shows. Only Concentration carried a credit count in its title, and it
-- was the sole requirement doing so — a redundancy the header (and, where they
-- exist, the child rows) already covers. Cleaned the analogous cases too.
--
--   baker-conc : "Concentration (12 cr, tracking both)" -> drop the redundant 12 cr
--                (kept "tracking both" — a real note, not a restated count)
--   phil-2000  : "2000-level or above (6+)"  -> "(6+)" just restates x/6
--   phil-3000  : "3000-level or above (3+)"  -> "(3+)" just restates x/3
--   as-dist    : "Distribution (10 categories)" -> the 10 is x/10 AND the 10
--                category children are listed on expand (doubly redundant)
--   ls-total   : "Five courses, ≥3 categories" -> "Five" restates x/5; kept the
--                real ≥3-category constraint
--
-- Left as-is (the number carries info the header does NOT show):
--   phil-total   "Courses in the major (8 core + 2 related)"  (composition; no child rows)
--   baker-intern "Summer Internship (8 wks)"  (a flag req — no x/N count shown at all)

update carnelian.requirements set name = 'Concentration (tracking both)' where id = 'baker-conc';
update carnelian.requirements set name = '2000-level or above'           where id = 'phil-2000';
update carnelian.requirements set name = '3000-level or above'           where id = 'phil-3000';
update carnelian.requirements set name = 'Distribution'                  where id = 'as-dist';
update carnelian.requirements set name = 'Courses across ≥3 categories'  where id = 'ls-total';
