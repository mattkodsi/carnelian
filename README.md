# Carnelian

A personal degree-audit and GPA command center — one place for a finished Cornell
undergrad (Philosophy BA + Law & Society and Real Estate minors, A&S distributions)
and an in-progress **Baker MPS in Real Estate**.

Live: **https://mattkodsi.github.io/carnelian/**

## What it does
- **Dashboard** — dual GPA (undergrad / grad), the active program's completion ring, and every requirement bucket at a glance.
- **Requirements** — auto-allocates your courses to major / minor / distribution / grad buckets. Four rule types (specific course, choose-from-pool, attribute match, credit total), with **pins** for the ambiguous cases and **adjustments** for petitions/waivers/credit transfers.
- **Planner** — courses by term; flags a course placed in a term it isn't offered.
- **Transcript** — grades → GPA, scoped per career (S/SX excluded).
- **Wishlist** — saved courses tagged to the bucket they'd fill.
- **Time-aware** — terms carry start/end dates, so status advances (planned → in progress → completed) and the app knows the current term.

## Architecture
- **Frontend:** a single static `index.html` (no build step), hosted on GitHub Pages.
- **Backend:** a Supabase Edge Function (`supabase/functions/carnelian`) that is the only thing with database access. The browser holds no keys — just a session token.
- **Auth:** one passcode, set on first launch, stored only as a PBKDF2 hash. Entered once; the session persists.
- **Data:** an isolated `carnelian` Postgres schema (RLS-locked; reachable only through the function).

Nothing sensitive lives in this repo — only the public project URL.

## Canvas check-offs
Canvas's calendar feed has no submission state, so a job on the Mac mini
(`scripts/canvas-checkoffs.mjs`) asks Canvas's planner, through the signed-in
cornell-agent, which items are submitted or checked off, and reports them to
`carnelian-canvas` every 10 minutes. Those items count as done in Carnelian and
leave the TV feed. To set it up:

1. Put the job's secret (`carnelian.canvas_config.completion_secret`) in
   `~/.config/carnelian/checkoffs.json` as `{"secret": "..."}`, mode 600.
2. `node scripts/canvas-checkoffs.mjs --dry-run` to see what it would report.
3. Copy `scripts/com.matt.carnelian-checkoffs.plist` to `~/Library/LaunchAgents/`
   and `launchctl load` it. It logs to `~/Library/Logs/carnelian-checkoffs.log`.

If Duo's browser trust lapses, the Canvas panel says so, and check-offs resume
after the next Cornell sign-in (cornell-agent's evening sign-in, or `./cornell
signin` from any chat).
