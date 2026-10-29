import { generateKeyPairSync } from "node:crypto";
import { z } from "zod";
import { decodePublicKey, encodePublicKey, type AgentIdentity } from "./identity.js";

const PairResponse = z.object({ machineId: z.string().min(1).max(200), hubPublicKey: z.string().min(1).max(200) });

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * Validates a hub URL. Plain http is allowed only for loopback: pairing returns the hub's job-signing key, so
 * anyone able to tamper with that answer could sign jobs for this machine.
 */
export function parseHubUrl(hubUrl: string): URL {
  const url = new URL(hubUrl);
  if (url.protocol === "https:") return url;
  if (url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname)) return url;
  throw new Error(`hub URL must use https: ${url.origin}`);
}

/**
 * Pairs this machine with a hub using a one-time code from the hub owner. Generates the machine's Ed25519 key
 * pair and sends `POST /pair` with `{code, name, publicKey}` (publicKey is base64url SPKI DER); the hub answers
 * `{machineId, hubPublicKey}` in the same encoding.
 */
export async function pairMachine(
  hubUrl: string,
  code: string,
  name: string,
  opts: { fetch?: typeof fetch } = {},
): Promise<AgentIdentity> {
  const base = parseHubUrl(hubUrl);
  const fetchFn = opts.fetch ?? fetch;
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const res = await fetchFn(new URL("/pair", base).href, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ code, name, publicKey: encodePublicKey(publicKey) }),
  });
  if (!res.ok) throw new Error(`pairing failed: HTTP ${res.status}`);
  const body = PairResponse.parse(await res.json());
  return {
    machineId: body.machineId,
    hubUrl,
    privateKey,
    hubPublicKey: decodePublicKey(body.hubPublicKey),
  };
}
