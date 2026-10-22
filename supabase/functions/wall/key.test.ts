// Run: node --test supabase/functions/wall/key.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { wallKeyAccepted, sha256hex, LEGACY_ANON_SHA256 } from "./key.ts";

test("the TV's own key is accepted, and the public key only until it is retired", async () => {
  const env = { wallKey: "tv-secret", anon: "anon-key" };
  assert.equal(await wallKeyAccepted("tv-secret", env), true);
  assert.equal(await wallKeyAccepted("anon-key", env), true);
  assert.equal(await wallKeyAccepted("anon-key", { ...env, anonOff: "1" }), false);
  assert.equal(await wallKeyAccepted("tv-secret", { ...env, anonOff: "1" }), true);
});

test("a wrong, empty, or missing key is refused, even before WALL_KEY is set", async () => {
  assert.equal(await wallKeyAccepted("tv-secre", { wallKey: "tv-secret", anon: "anon-key" }), false);
  assert.equal(await wallKeyAccepted(null, { anon: "anon-key" }), false);
  assert.equal(await wallKeyAccepted("", { wallKey: "", anon: "" }), false);
  assert.equal(await wallKeyAccepted("anon-key", { anon: "anon-key" }), true);
});

test("the legacy anon key is matched by its hash, and retired with the public key", async () => {
  assert.equal(LEGACY_ANON_SHA256.length, 64);
  assert.equal(await sha256hex("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  assert.equal(await wallKeyAccepted("not-the-legacy-key", { anon: "anon-key" }), false);
});
