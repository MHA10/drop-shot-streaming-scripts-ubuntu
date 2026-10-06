/**
 * Log-safe copy of a settings object, with secret values masked.
 *
 * ── IN SIMPLE WORDS ──
 * At startup the app prints its settings so we can see how a box is set up.
 * Some of those settings are passwords: the backend access key, the Cloudinary
 * secret, the Supabase key. This makes a copy where each one is replaced by
 * "[redacted]", so the log still shows WHETHER it is set, but never WHAT it is.
 *
 * ── BUSINESS RULES ──
 * - Every venue box was writing STREAMING_API_KEY and CLOUDINARY_API_SECRET in
 *   plain text to its PM2 log files on every start (seen in the Padel Bridge
 *   startup log, 2026-10-06). Anyone who can read those files, or a log someone
 *   pastes into a chat, gets the keys.
 * - An empty secret stays "" instead of "[redacted]", so a box with a missing
 *   key (e.g. no Cloudinary credentials) is still obvious from the log.
 *
 * ── WHY IT'S BUILT THIS WAY (change at your peril) ──
 * Secrets are found by field NAME (ends in key/secret/token/password), not by
 * a fixed list of paths. A fixed list fails open: the next secret someone adds
 * to AppConfig would be logged in clear until someone remembers to update the
 * list. Matching by name fails closed. Today the pattern matches exactly
 * streamingApiKey, anonKey, apiKey and apiSecret, and no other AppConfig field.
 *
 * ── DO NOT ──
 * - Do NOT log config.get() directly. Pass it through redactSecrets() first.
 * - Do NOT name a new secret setting so it dodges the pattern (e.g.
 *   "cloudinaryCredential"). End the name in Key, Secret, Token or Password.
 */

const SECRET_FIELD = /(key|secret|token|password)$/i;

export const REDACTED = "[redacted]";

/** Deep copy of `value` with every non-empty secret-named field masked. */
export function redactSecrets(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(redactSecrets);
  }
  if (value === null || typeof value !== "object") {
    return value;
  }
  const copy: Record<string, unknown> = {};
  for (const [field, inner] of Object.entries(value)) {
    const isEmpty = inner === undefined || inner === null || inner === "";
    copy[field] =
      SECRET_FIELD.test(field) && !isEmpty ? REDACTED : redactSecrets(inner);
  }
  return copy;
}
