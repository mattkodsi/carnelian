import { sameSecret } from "../_shared/secret.ts";

// The TV reads the feed with its own key (function secret WALL_KEY), sent as
// ?key= or an x-wall-key header. The public anon key is still accepted during the
// cutover; setting WALL_ANON_OFF=1 retires it once the TV sends the new key.
export function wallKeyAccepted(given: string | null, env: { wallKey?: string; anon?: string; anonOff?: string }) {
  if (sameSecret(given, env.wallKey)) return true;
  return env.anonOff !== "1" && sameSecret(given, env.anon);
}
