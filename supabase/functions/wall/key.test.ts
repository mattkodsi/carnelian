// Run: node --test supabase/functions/wall/key.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { wallKeyAccepted } from "./key.ts";

test("the TV's own key is accepted, and the anon key only until it is retired", () => {
  const env = { wallKey: "tv-secret", anon: "anon-key" };
  assert.equal(wallKeyAccepted("tv-secret", env), true);
  assert.equal(wallKeyAccepted("anon-key", env), true);
  assert.equal(wallKeyAccepted("anon-key", { ...env, anonOff: "1" }), false);
  assert.equal(wallKeyAccepted("tv-secret", { ...env, anonOff: "1" }), true);
});

test("a wrong, empty, or missing key is refused, even before WALL_KEY is set", () => {
  assert.equal(wallKeyAccepted("tv-secre", { wallKey: "tv-secret", anon: "anon-key" }), false);
  assert.equal(wallKeyAccepted(null, { anon: "anon-key" }), false);
  assert.equal(wallKeyAccepted("", { wallKey: "", anon: "" }), false);
  assert.equal(wallKeyAccepted("anon-key", { anon: "anon-key" }), true);
});
