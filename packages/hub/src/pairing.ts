import { createPublicKey, type KeyObject } from "node:crypto";
import express from "express";
import { z } from "zod";
import type { Store } from "./store.js";

export const PAIR_PATH = "/pair";

const PAIR_ATTEMPTS_PER_WINDOW = 10;
const PAIR_WINDOW_MS = 60_000;

/** Ed25519 public key as base64url SPKI DER. */
const PublicKey = z
  .string()
  .max(200)
  .regex(/^[A-Za-z0-9_-]+$/)
  .refine((encoded) => {
    try {
      const key = createPublicKey({ key: Buffer.from(encoded, "base64url"), format: "der", type: "spki" });
      return key.asymmetricKeyType === "ed25519";
    } catch {
      return false;
    }
  });

const PairRequest = z
  .object({
    code: z.string().min(1).max(100),
    name: z.string().min(1).max(100),
    publicKey: PublicKey,
  })
  .strict();

/** Fixed-window attempt counter per key, in memory. */
export class RateLimiter {
  private readonly windows = new Map<string, { start: number; count: number }>();

  constructor(
    private readonly max: number,
    private readonly windowMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  /** Counts an attempt; false when the key is over its limit for the current window. */
  attempt(key: string): boolean {
    const now = this.now();
    let window = this.windows.get(key);
    if (!window || now - window.start >= this.windowMs) {
      if (this.windows.size > 10_000) this.prune(now);
      window = { start: now, count: 0 };
      this.windows.set(key, window);
    }
    window.count += 1;
    return window.count <= this.max;
  }

  private prune(now: number): void {
    for (const [key, window] of this.windows) if (now - window.start >= this.windowMs) this.windows.delete(key);
  }
}

/**
 * `POST /pair` with `{code, name, publicKey}` (publicKey: the machine's Ed25519 key, base64url SPKI DER).
 * Answers `{machineId, hubPublicKey}` (same encoding). Unauthenticated, so it is rate limited per client IP
 * (`req.ip`, which honors the app's trust-proxy setting). A bad, reused or expired code all get the same 400.
 */
export function pairRouter(store: Store, hubPublicKey: KeyObject): express.Router {
  const limiter = new RateLimiter(PAIR_ATTEMPTS_PER_WINDOW, PAIR_WINDOW_MS, store.now);
  const encodedHubKey = hubPublicKey.export({ format: "der", type: "spki" }).toString("base64url");
  const router = express.Router();
  router.post(
    PAIR_PATH,
    (req, res, next) => {
      if (limiter.attempt(req.ip ?? "unknown")) return next();
      res.status(429).json({ error: "too_many_requests" });
    },
    express.json({ limit: "4kb" }),
    (req, res) => {
      // Validate before redeeming: redemption consumes the code.
      const body = PairRequest.safeParse(req.body);
      if (!body.success) {
        res.status(400).json({ error: "invalid_request" });
        return;
      }
      const machine = store.redeemPairingCode(body.data.code, body.data.name, body.data.publicKey);
      if (!machine) {
        res.status(400).json({ error: "invalid_pairing_code" });
        return;
      }
      res.json({ machineId: machine.id, hubPublicKey: encodedHubKey });
    },
  );
  return router;
}
