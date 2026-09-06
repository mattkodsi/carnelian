# September 6 audit fixes

Prepared locally only. No production migration, deployment, merge, or data writes performed.

## Behavior

- Google Calendar failures now reject reconciliation; 404/410 PATCH still recreate missing events, and 404/410 DELETE count as already absent. Failed updates retain their prior signatures; failed deletes retain event maps for the next sync. Disabling a calendar layer or disconnecting also retains identifiers if Google deletion fails, so retry can clean up the calendar instead of orphaning it.
- Automatic frontend sync serializes requests and coalesces edits made during a request into a subsequent sync. A queued edit gets an attempt even if the previous request fails. This is a page-local queue, not a cross-tab/distributed lock or an offline durable queue.
- Assignment save, approval, completion changes, deletion, and rejection request reconciliation after persistence succeeds.
- Canvas updates compare date and normalized minute time. Rejected/deleted feed UIDs persist in a private tombstone table. Database triggers cover older clients and importers as well as the updated importer; per-UID transaction locks serialize concurrent rejection/insertion. Deleting an imported assignment (including course deletion) intentionally suppresses that UID permanently. Previously deleted UIDs cannot be reconstructed from missing records; this takes effect prospectively. To restore a deliberately rejected UID, an administrator must explicitly remove its tombstone.
- F grades contribute no earned/planned degree credits, requirement courses, or coverage. The F remains in GPA calculations, including undergrad coursework applied to Baker graduate GPA. Paid TA and audit roles also cannot contribute scope-based credit progress.
- `today()` uses America/New_York in winter and summer.

## Deployment order for later approval

1. Exercise `supabase/migrations/20260906_canvas_rejections.sql` on an isolated PostgreSQL database with the existing schema, verifying rejection, retry, concurrent insert/delete, and role access. Apply it to production only after approval. The migration is additive and preserves current assignments.
2. Deploy the updated `carnelian-canvas` function, which requires the new table. Deploy the `carnelian` function with the Google failure handling.
3. Publish the updated frontend. Old frontend deletion already activates the new tombstone trigger; no coordinated frontend switch is needed.
4. In an authorized test account, verify real Google 429/5xx retry and deletion, Canvas import after rejection, and the browser's connected-calendar flows.

Rollback frontend/functions independently; keep the additive table/triggers so previously rejected UIDs remain suppressed. Reverting the Canvas function before reverting the migration avoids a missing-table error. Removing the tombstones or triggers restores the original reimport bug and loses suppression history.

## Verification

`node --test tests/audit.test.mjs supabase/functions/carnelian-canvas/ical.test.ts`

The regression suite runs real source code in a VM with synthetic database/network boundaries and performs a whole frontend-script parse. The original revision fails 17 behavioral assertions. Fixed code passes all 30 tests, including 11 existing iCal tests. Node 24 emits its expected experimental type-stripping warning. `git diff --check` also passes.

No local PostgreSQL server was available, so migration execution, permissions, and concurrent transaction behavior require the isolated database verification above. No live Google/Canvas requests or browser smoke test were performed by this task.
