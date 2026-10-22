const enc = new TextEncoder();

// Constant-time comparison for shared secrets. An empty secret never matches.
export function sameSecret(a: unknown, b: unknown) {
  const x = enc.encode(String(a ?? "")), y = enc.encode(String(b ?? ""));
  if (!x.length || x.length !== y.length) return false;
  let d = 0; for (let i = 0; i < x.length; i++) d |= x[i] ^ y[i];
  return d === 0;
}
