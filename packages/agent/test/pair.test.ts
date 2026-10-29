import { createPublicKey, generateKeyPairSync, sign, verify } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { defaultIdentityPath, loadIdentity, pairMachine, saveIdentity, type AgentIdentity } from "../src/index.js";

const MACHINE_ID = "6f9c2a52-4c55-4f3f-9a55-3a2d9a0c1e11";
const hubKey = generateKeyPairSync("ed25519");
const hubPublicKeyDer = hubKey.publicKey.export({ format: "der", type: "spki" }).toString("base64url");

interface Seen {
  url: string;
  body: Record<string, unknown>;
}

function stubHub(respond: (body: Record<string, unknown>) => Response = () => Response.json({ machineId: MACHINE_ID, hubPublicKey: hubPublicKeyDer })) {
  const seen: Seen[] = [];
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    seen.push({ url: String(input), body });
    return respond(body);
  }) as typeof fetch;
  return { fetch: fetchFn, seen };
}

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "hoistline-agent-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("pairMachine", () => {
  it("posts the code, name and a fresh Ed25519 public key, and returns an identity", async () => {
    const hub = stubHub();
    const identity = await pairMachine("https://hub.example.com", "ABCD-EFGH-JKMN", "laptop", { fetch: hub.fetch });

    expect(hub.seen).toHaveLength(1);
    expect(hub.seen[0]!.url).toBe("https://hub.example.com/pair");
    const { code, name, publicKey } = hub.seen[0]!.body as { code: string; name: string; publicKey: string };
    expect({ code, name }).toEqual({ code: "ABCD-EFGH-JKMN", name: "laptop" });

    expect(identity.machineId).toBe(MACHINE_ID);
    expect(identity.hubUrl).toBe("https://hub.example.com");
    expect(identity.privateKey.asymmetricKeyType).toBe("ed25519");
    expect(identity.hubPublicKey.export({ format: "der", type: "spki" }).toString("base64url")).toBe(hubPublicKeyDer);
    // The key sent to the hub is the public half of the identity's private key.
    const sent = createPublicKey({ key: Buffer.from(publicKey, "base64url"), format: "der", type: "spki" });
    const sig = sign(null, Buffer.from("x"), identity.privateKey);
    expect(verify(null, Buffer.from("x"), sent, sig)).toBe(true);
  });

  it("throws a generic error when the hub refuses the code", async () => {
    const hub = stubHub(() => Response.json({ error: "invalid_pairing_code" }, { status: 400 }));
    await expect(pairMachine("https://hub.example.com", "bad", "laptop", { fetch: hub.fetch })).rejects.toThrow(
      /pairing failed: HTTP 400/,
    );
  });

  it("refuses a malformed hub answer", async () => {
    const hub = stubHub(() => Response.json({ machineId: MACHINE_ID, hubPublicKey: "not a key" }));
    await expect(pairMachine("https://hub.example.com", "c", "laptop", { fetch: hub.fetch })).rejects.toThrow();
  });

  it("does not follow a redirect from /pair", async () => {
    const hits: string[] = [];
    const server = createServer((req, res) => {
      hits.push(`${req.method} ${req.url}`);
      if (req.url === "/pair") {
        res.writeHead(307, { location: "/elsewhere" }).end();
      } else {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ machineId: MACHINE_ID, hubPublicKey: hubPublicKeyDer }));
      }
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    try {
      const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      await expect(pairMachine(url, "c", "laptop")).rejects.toThrow();
      expect(hits).toEqual(["POST /pair"]);
    } finally {
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
    }
  });

  it("requires https except for loopback hubs", async () => {
    const hub = stubHub();
    await expect(pairMachine("http://hub.example.com", "c", "laptop", { fetch: hub.fetch })).rejects.toThrow(/https/);
    expect(hub.seen).toHaveLength(0);
    await expect(pairMachine("http://127.0.0.1:8080", "c", "laptop", { fetch: hub.fetch })).resolves.toBeTruthy();
    await expect(pairMachine("http://localhost:8080", "c", "laptop", { fetch: hub.fetch })).resolves.toBeTruthy();
  });
});

describe("identity files", () => {
  async function identity(): Promise<AgentIdentity> {
    return pairMachine("https://hub.example.com", "c", "laptop", { fetch: stubHub().fetch });
  }

  it("saves with file mode 0600 in a 0700 directory and loads it back", async () => {
    const id = await identity();
    const path = join(dir, "home", "identity.json");
    saveIdentity(path, id);
    if (process.platform !== "win32") {
      expect(statSync(path).mode & 0o777).toBe(0o600);
      expect(statSync(join(dir, "home")).mode & 0o777).toBe(0o700);
    }
    const loaded = loadIdentity(path);
    expect(loaded.machineId).toBe(id.machineId);
    expect(loaded.hubUrl).toBe(id.hubUrl);
    const der = (k: AgentIdentity["hubPublicKey"]) => k.export({ format: "der", type: "spki" }).toString("base64");
    expect(der(loaded.hubPublicKey)).toBe(der(id.hubPublicKey));
    expect(der(createPublicKey(loaded.privateKey))).toBe(der(createPublicKey(id.privateKey)));
  });

  it("tightens the mode when overwriting an existing file", async () => {
    const path = join(dir, "identity.json");
    writeFileSync(path, "{}", { mode: 0o644 });
    saveIdentity(path, await identity());
    if (process.platform !== "win32") expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(path, "utf8")).machineId).toBe(MACHINE_ID);
  });

  it("tightens an existing directory to 0700", async () => {
    const home = join(dir, "existing");
    mkdirSync(home, { mode: 0o755 });
    chmodSync(home, 0o755);
    saveIdentity(join(home, "identity.json"), await identity());
    if (process.platform !== "win32") expect(statSync(home).mode & 0o777).toBe(0o700);
    expect(readdirSync(home)).toEqual(["identity.json"]); // no temp file left behind
  });

  it("rejects a malformed identity file", () => {
    const path = join(dir, "identity.json");
    writeFileSync(path, JSON.stringify({ machineId: MACHINE_ID }));
    expect(() => loadIdentity(path)).toThrow();
  });

  it("defaults to ~/.hoistline and honors HOISTLINE_AGENT_HOME", () => {
    expect(defaultIdentityPath({ HOISTLINE_AGENT_HOME: "/srv/agent" })).toBe(join("/srv/agent", "identity.json"));
    expect(defaultIdentityPath({})).toMatch(/\.hoistline[\\/]identity\.json$/);
  });
});
