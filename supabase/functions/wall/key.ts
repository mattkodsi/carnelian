import { sameSecret } from "../_shared/secret.ts";

// The TV has always sent the project's legacy anon key (a JWT). Newly deployed
// functions get the new publishable key as SUPABASE_ANON_KEY instead, so the
// legacy key is recognized by its SHA-256 (the key itself stays out of the repo).
export const LEGACY_ANON_SHA256 = "1fbbf44fd49257b7d9b8452cd1a51ef1569402794ac973c8193c46aecca7ef25";

export async function sha256hex(s: string) {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// The TV reads the feed with its own key (function secret WALL_KEY), sent as
// ?key= or an x-wall-key header. The public keys (publishable and legacy anon)
// are still accepted during the cutover; WALL_ANON_OFF=1 retires them once the
// TV sends the new key.
export async function wallKeyAccepted(given: string | null, env: { wallKey?: string; anon?: string; anonOff?: string }) {
  if (sameSecret(given, env.wallKey)) return true;
  if (env.anonOff === "1" || !given) return false;
  return sameSecret(given, env.anon) || sameSecret(await sha256hex(given), LEGACY_ANON_SHA256);
}
