-- Coupled credit floors: the A&S BA needs BOTH ≥100 credits in Arts & Sciences AND ≥120 credits overall.
-- These were modeled as two independent requirements, so "Total credits" read complete at 122.5/120 even
-- while "Credits in Arts & Sciences" sat at 98/100 — a false "done". Gate the total on the A&S floor:
-- spec.alsoRequire lists requirement ids that must ALSO be met before this one counts as complete. When the
-- total's own credits already clear 120 but the A&S floor isn't met, the engine marks it `gatedOnly` (not
-- green, shows "N more A&S credits needed") and the actionable shortfall stays on the A&S requirement.
-- The engine (reqProgress in index.html) reads spec.alsoRequire generically; this only wires the data.
update carnelian.requirements set spec = jsonb_set(spec, '{alsoRequire}', '["as-ascred"]'::jsonb)
where id = 'as-total';

-- Terse label for the gate note ("2 more A&S credits needed"); falls back to the full name if unset.
update carnelian.requirements set spec = jsonb_set(spec, '{short}', '"A&S credits"'::jsonb)
where id = 'as-ascred';
