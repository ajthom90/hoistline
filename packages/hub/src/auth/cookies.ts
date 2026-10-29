import { createHmac, timingSafeEqual } from "node:crypto";

/** Parses a Cookie request header into name/value pairs (first occurrence wins). */
export function parseCookies(header: string | undefined): Map<string, string> {
  const cookies = new Map<string, string>();
  for (const part of (header ?? "").split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    const name = part.slice(0, eq).trim();
    if (name && !cookies.has(name)) cookies.set(name, part.slice(eq + 1).trim());
  }
  return cookies;
}

export interface CookieOptions {
  secure: boolean;
  /** Seconds; 0 deletes the cookie. */
  maxAge: number;
  path?: string;
}

/** A Set-Cookie value: always HttpOnly and SameSite=Lax, Secure when the hub is served over https. */
export function serializeCookie(name: string, value: string, options: CookieOptions): string {
  const parts = [`${name}=${value}`, `Path=${options.path ?? "/"}`, `Max-Age=${options.maxAge}`, "HttpOnly", "SameSite=Lax"];
  if (options.secure) parts.push("Secure");
  return parts.join("; ");
}

/** Equal-length-safe constant-time string comparison. */
export function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

/** HMAC-signs cookie payloads as `<base64url payload>.<base64url mac>`. */
export class CookieSigner {
  constructor(private readonly secret: string) {}

  private mac(payload: string): string {
    return createHmac("sha256", this.secret).update(payload).digest("base64url");
  }

  sign(data: string): string {
    const payload = Buffer.from(data).toString("base64url");
    return `${payload}.${this.mac(payload)}`;
  }

  /** The signed data, or undefined when the value is missing or its signature does not match. */
  verify(value: string | undefined): string | undefined {
    if (!value) return undefined;
    const dot = value.lastIndexOf(".");
    if (dot < 0) return undefined;
    const payload = value.slice(0, dot);
    if (!safeEqual(value.slice(dot + 1), this.mac(payload))) return undefined;
    return Buffer.from(payload, "base64url").toString();
  }
}
