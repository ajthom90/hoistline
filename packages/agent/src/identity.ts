import { createPrivateKey, createPublicKey, type KeyObject } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { z } from "zod";

/**
 * A paired machine. Keys are KeyObjects in memory so they never print as key material.
 * On disk (see saveIdentity) the private key is PKCS8 PEM and the hub key is base64url SPKI DER.
 */
export interface AgentIdentity {
  machineId: string;
  /** Hub base URL as given at pairing, e.g. https://hub.example.com. */
  hubUrl: string;
  /** This machine's Ed25519 private key; proves the machine to the hub. */
  privateKey: KeyObject;
  /** The hub's Ed25519 job-signing public key, for verifyJob. */
  hubPublicKey: KeyObject;
}

const IdentityFile = z
  .object({
    version: z.literal(1),
    machineId: z.string().min(1).max(200),
    hubUrl: z.string().url(),
    privateKey: z.string().min(1),
    hubPublicKey: z.string().min(1),
  })
  .strict();

/** Decodes a base64url SPKI DER Ed25519 public key; throws on anything else. */
export function decodePublicKey(encoded: string): KeyObject {
  if (!/^[A-Za-z0-9_-]+$/.test(encoded)) throw new Error("malformed public key");
  const key = createPublicKey({ key: Buffer.from(encoded, "base64url"), format: "der", type: "spki" });
  if (key.asymmetricKeyType !== "ed25519") throw new Error("public key must be Ed25519");
  return key;
}

export function encodePublicKey(key: KeyObject): string {
  return key.export({ format: "der", type: "spki" }).toString("base64url");
}

/** `$HOISTLINE_AGENT_HOME/identity.json`, defaulting to `~/.hoistline/identity.json`. */
export function defaultIdentityPath(env: Record<string, string | undefined> = process.env): string {
  const home = env.HOISTLINE_AGENT_HOME?.trim() || join(homedir(), ".hoistline");
  return join(home, "identity.json");
}

/** Writes the identity as JSON, file mode 0600, creating its directory with mode 0700. */
export function saveIdentity(path: string, identity: AgentIdentity): void {
  const file: z.infer<typeof IdentityFile> = {
    version: 1,
    machineId: identity.machineId,
    hubUrl: identity.hubUrl,
    privateKey: identity.privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
    hubPublicKey: encodePublicKey(identity.hubPublicKey),
  };
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  // Write a private temp file and rename it over the target, so an existing file's looser mode never applies.
  const tmp = `${path}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    chmodSync(tmp, 0o600);
    renameSync(tmp, path);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
}

export function loadIdentity(path: string): AgentIdentity {
  const file = IdentityFile.parse(JSON.parse(readFileSync(path, "utf8")));
  const privateKey = createPrivateKey(file.privateKey);
  if (privateKey.asymmetricKeyType !== "ed25519") throw new Error("identity private key must be Ed25519");
  return {
    machineId: file.machineId,
    hubUrl: file.hubUrl,
    privateKey,
    hubPublicKey: decodePublicKey(file.hubPublicKey),
  };
}
