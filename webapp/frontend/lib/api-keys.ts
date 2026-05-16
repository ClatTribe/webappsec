// Tier II #8 — MCP server API key helpers.
//
// Mints + hashes + formats keys for the MCP Bearer auth flow. The full
// key is returned to the caller exactly once at mint time; we persist
// only the SHA-256 hash + a visible prefix.
//
// Key shape:
//   ts_<prefix>_<random>
//
// Where:
//   - ts_       fixed scheme tag (so a leaked string is unambiguous in
//               logs and search — distinguishes our keys from sk_/pk_
//               keys from other vendors)
//   - <prefix>  8 chars [a-z0-9] — shown in the UI list ("ts_a3f9...")
//               so the user can identify which key is which without
//               re-revealing the secret
//   - <random>  32-byte random base32 — the secret material
//
// The full key is therefore ~55 characters. Comfortably under the
// typical Authorization header size limit and easy to copy/paste.

import { randomBytes, createHash } from 'crypto';

const KEY_SCHEME = 'ts_';

/** Mint a new API key. Returns the full plaintext key (caller MUST
 *  show this to the user exactly once) plus the prefix + hash to
 *  store in the database. */
export function mintApiKey(): { fullKey: string; prefix: string; hash: string } {
  // 8-char prefix from base32 alphabet (no l/0/1 ambiguity).
  // Generated as 5 bytes → base32 → first 8 chars.
  const prefixBytes = randomBytes(5);
  const prefix = base32(prefixBytes).slice(0, 8).toLowerCase();

  // 32 bytes (256 bits) random for the secret half. Base32 keeps it
  // case-insensitive paste-friendly across terminals + Cursor/CC config.
  const secretBytes = randomBytes(32);
  const secret = base32(secretBytes).toLowerCase();

  const fullKey = `${KEY_SCHEME}${prefix}_${secret}`;
  const hash = hashApiKey(fullKey);
  return { fullKey, prefix, hash };
}

/** SHA-256(plaintext key) as hex — the exact value stored in
 *  public.api_keys.key_hash. */
export function hashApiKey(fullKey: string): string {
  return createHash('sha256').update(fullKey, 'utf8').digest('hex');
}

/** Validate the surface shape of a presented key. Doesn't check the
 *  hash against the DB — that's a SECURITY DEFINER RPC call. This is
 *  a cheap pre-filter that lets us 401 obviously-malformed Bearer
 *  values without touching the DB. */
export function isWellFormedApiKey(s: string): boolean {
  if (!s.startsWith(KEY_SCHEME)) return false;
  const parts = s.slice(KEY_SCHEME.length).split('_');
  if (parts.length !== 2) return false;
  const [prefix, secret] = parts;
  if (prefix.length !== 8) return false;
  if (secret.length < 16) return false;
  // base32 chars only (no = padding — we strip it)
  return /^[a-z2-7]+$/.test(prefix) && /^[a-z2-7]+$/.test(secret);
}

/** Extract the prefix from a full key (used by the UI on mint to
 *  display the same prefix the user will see in the keys list). */
export function prefixOf(fullKey: string): string {
  return fullKey.slice(KEY_SCHEME.length, KEY_SCHEME.length + 8);
}

// ---- base32 (RFC 4648, lowercase, no padding) ----------------------
// Stdlib doesn't ship a base32 encoder — node:buffer only has base64.
// 30 lines of trivial code beats pulling in a dep.
const B32 = 'abcdefghijklmnopqrstuvwxyz234567';

function base32(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let output = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) {
    output += B32[(value << (5 - bits)) & 31];
  }
  return output;
}
