import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';

test('Canvas migration preserves rejections, blocks reimports/adoption, and protects private state', async () => {
  const db = new PGlite();
  try {
    await db.exec(`
      create role anon; create role authenticated; create role test_gateway;
      create schema carnelian;
      create table carnelian.assignments (
        id integer primary key, source text, ext_uid text unique
      );
      grant usage on schema carnelian to anon, authenticated, test_gateway;
      grant select, insert, update, delete on carnelian.assignments to test_gateway;
    `);
    const migration = readFileSync(new URL('../supabase/migrations/20260906_canvas_rejections.sql', import.meta.url), 'utf8');
    await db.exec(migration);
    await db.exec(migration); // Reapplying is safe.
    for (const role of ['anon', 'authenticated', 'test_gateway']) {
      const { rows: [rights] } = await db.query(`select
        has_table_privilege($1, 'carnelian.canvas_rejections', 'SELECT') as can_read,
        has_table_privilege($1, 'carnelian.canvas_rejections', 'INSERT') as can_insert,
        has_table_privilege($1, 'carnelian.canvas_rejections', 'DELETE') as can_delete,
        has_function_privilege($1, 'carnelian.remember_canvas_rejection()', 'EXECUTE') as can_execute`, [role]);
      assert.deepEqual(rights, {can_read: false, can_insert: false, can_delete: false, can_execute: false});
    }
    const { rows: [security] } = await db.query(`select relrowsecurity from pg_class where oid='carnelian.canvas_rejections'::regclass`);
    assert.equal(security.relrowsecurity, true);
    // The gateway can delete assignments while the trigger alone writes private tombstones.
    await db.exec(`set role test_gateway;
      insert into carnelian.assignments values (1, 'canvas', 'assignment-1');
      delete from carnelian.assignments where id=1;
      insert into carnelian.assignments values (2, 'canvas', 'assignment-1');
      insert into carnelian.assignments values (3, 'canvas', null);
      update carnelian.assignments set ext_uid='assignment-1' where id=3;
      reset role;`);
    assert.deepEqual((await db.query('select ext_uid from carnelian.canvas_rejections')).rows, [{ext_uid: 'assignment-1'}]);
    assert.deepEqual((await db.query('select id, ext_uid from carnelian.assignments')).rows, [{id: 3, ext_uid: null}]);
    // A rolled-back delete cannot accidentally suppress a still-existing assignment.
    await db.exec(`insert into carnelian.assignments values (4,'canvas','assignment-4');
      begin; delete from carnelian.assignments where id=4; rollback;`);
    assert.equal((await db.query("select count(*)::int as n from carnelian.canvas_rejections where ext_uid='assignment-4'")).rows[0].n, 0);
    await db.exec(`insert into carnelian.assignments values (5,'manual','manual-5');
      delete from carnelian.assignments where id in (3,5);`);
    assert.equal((await db.query('select count(*)::int as n from carnelian.canvas_rejections')).rows[0].n, 1);
  } finally {
    await db.close();
  }
});

test('Canvas source-state migration adds durable provenance without changing custom assignment fields', async () => {
  const db = new PGlite();
  try {
    await db.exec(`
      create schema carnelian;
      create table carnelian.assignments (
        id integer primary key, name text, override_title text, due_on date,
        due_time time, target_on date, target_time time, source text, ext_uid text
      );
      insert into carnelian.assignments values
        (1, 'My title', 'My override', '2026-09-15', '08:00', '2026-09-14', '23:59', 'canvas', 'assignment-1');
    `);
    const migration = readFileSync(new URL('../supabase/migrations/20260913182946_canvas_source_state.sql', import.meta.url), 'utf8');
    await db.exec(migration);
    await db.exec(migration);

    const { rows: [row] } = await db.query(`select name, override_title, due_on::text, due_time::text,
      target_on::text, target_time::text, canvas_title, canvas_removed_at,
      canvas_missing_count, canvas_changes from carnelian.assignments where id=1`);
    assert.deepEqual(row, {
      name: 'My title', override_title: 'My override', due_on: '2026-09-15', due_time: '08:00:00',
      target_on: '2026-09-14', target_time: '23:59:00', canvas_title: null,
      canvas_removed_at: null, canvas_missing_count: 0, canvas_changes: {},
    });
  } finally {
    await db.close();
  }
});

test('unassigned Canvas inbox is private, idempotent, and preserves source lifecycle state', async () => {
  const db = new PGlite();
  try {
    await db.exec('create role anon; create role authenticated; create schema carnelian;');
    const migration = readFileSync(new URL('../supabase/migrations/20260913184959_canvas_unassigned_inbox.sql', import.meta.url), 'utf8');
    await db.exec(migration); await db.exec(migration);
    await db.exec(`insert into carnelian.canvas_unassigned (ext_uid, canvas_title, canvas_due_on)
      values ('assignment-u1', 'Program survey', '2026-09-20')`);
    const { rows: [row] } = await db.query(`select ext_uid, canvas_title, canvas_due_on::text,
      canvas_missing_count, canvas_changes from carnelian.canvas_unassigned`);
    assert.deepEqual(row, {ext_uid:'assignment-u1', canvas_title:'Program survey', canvas_due_on:'2026-09-20', canvas_missing_count:0, canvas_changes:{}});
    for (const role of ['anon','authenticated']) {
      const { rows: [rights] } = await db.query(`select
        has_table_privilege($1, 'carnelian.canvas_unassigned', 'SELECT') as can_read,
        has_table_privilege($1, 'carnelian.canvas_unassigned', 'INSERT') as can_insert`, [role]);
      assert.deepEqual(rights, {can_read:false, can_insert:false});
    }
  } finally { await db.close(); }
});
