/**
 * Runbooks tokens: how an agent proves who it acts for.
 *
 * A token is "rbk_" plus 32 random bytes in base64url. Only its sha256 is
 * stored. A check compares the hash against every live token in constant
 * time, so neither the comparison nor an early exit says how close a guess
 * was.
 */

import crypto from "node:crypto";
import type { Store, TokenRow } from "./store.js";

export const TOKEN_PREFIX = "rbk_";
const TOKEN_SHAPE = /^rbk_[A-Za-z0-9_-]{43}$/;

export function newToken(): { token: string; hash: string; prefix: string } {
  const token = TOKEN_PREFIX + crypto.randomBytes(32).toString("base64url");
  return { token, hash: hashToken(token), prefix: token.slice(0, 8) };
}

export function hashToken(token: string): string {
  return crypto.createHash("sha256").update(token, "utf8").digest("hex");
}

/** The bearer token of a request, or null. */
export function bearer(header: unknown): string | null {
  if (typeof header !== "string") return null;
  const match = /^Bearer\s+(\S+)\s*$/i.exec(header);
  return match ? match[1] : null;
}

export type TokenCheck =
  | { ok: true; token: TokenRow }
  | { ok: false; reason: "missing" | "invalid" | "revoked" };

/** Finds the live token a presented secret belongs to. */
export async function checkToken(
  store: Store,
  presented: string | null,
): Promise<TokenCheck> {
  if (!presented) return { ok: false, reason: "missing" };
  const hash = Buffer.from(hashToken(presented), "hex");
  const wellFormed = TOKEN_SHAPE.test(presented);
  const live = await store.activeTokens();
  let found: TokenRow | null = null;
  for (const row of live) {
    const stored = Buffer.from(row.tokenHash, "hex");
    if (stored.length === hash.length && crypto.timingSafeEqual(stored, hash)) {
      found = row;
    }
  }
  if (found && wellFormed) return { ok: true, token: found };
  // Only a token that exists but was revoked gets its own answer.
  if (wellFormed && (await store.findTokenByHash(hash.toString("hex")))) {
    return { ok: false, reason: "revoked" };
  }
  return { ok: false, reason: "invalid" };
}

/** Requests per minute per token, counted in memory. */
export function createRateLimiter(limit: number, windowMs = 60_000) {
  const hits = new Map<number, { count: number; resetAt: number }>();
  return {
    /** True when this request goes over the limit. */
    over(tokenId: number, at = Date.now()): boolean {
      if (hits.size > 1000) {
        for (const [key, entry] of hits) {
          if (entry.resetAt <= at) hits.delete(key);
        }
      }
      const entry = hits.get(tokenId);
      if (!entry || entry.resetAt <= at) {
        hits.set(tokenId, { count: 1, resetAt: at + windowMs });
        return false;
      }
      entry.count++;
      return entry.count > limit;
    },
    reset(): void {
      hits.clear();
    },
  };
}
