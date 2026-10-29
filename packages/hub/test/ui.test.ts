import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { describeReason } from "../src/jobs.js";
import {
  Browser,
  createPat,
  delegateArgs,
  disposeContext,
  mcpClient,
  newContext,
  onlineAgent,
  page,
  pair,
  post,
  RawAgent,
  startHub,
  startUiLogin,
  uiLogin,
  waitFor,
  type Hub,
  type TestContext,
} from "./ui-helpers.js";

let ctx: TestContext;
let browser: Browser;
beforeEach(() => {
  ctx = newContext();
  browser = new Browser();
});
afterEach(() => disposeContext(ctx));

const HOUR = 60 * 60 * 1000;

const callback = (hub: Hub, b: Browser, params: Record<string, string>) =>
  b.request(`${hub.url}/oauth/callback?${new URLSearchParams(params)}`);

describe("web login", () => {
  it("redirects /ui pages to /ui/login without a session", async () => {
    const hub = await startHub(ctx);
    for (const path of ["/ui", "/ui/jobs", "/ui/tokens"]) {
      const res = await browser.request(`${hub.url}${path}`);
      expect(res.status).toBe(303);
      expect(res.headers.get("location")).toBe("/ui/login");
    }
    const res = await browser.postForm(`${hub.url}/ui/pair`, {});
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/ui/login");
  });

  it("logs in through GitHub, sets hl_session and lands on /ui", async () => {
    const hub = await startHub(ctx);
    const upstream = await startUiLogin(hub, browser);
    expect(`${upstream.origin}${upstream.pathname}`).toBe("https://github.com/login/oauth/authorize");
    expect(upstream.searchParams.get("redirect_uri")).toBe(`${hub.url}/oauth/callback`);
    const res = await callback(hub, browser, { code: "code-alice", state: upstream.searchParams.get("state")! });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/ui");
    const cookie = browser.setCookieHeaders.find((h) => h.startsWith("hl_session="))!;
    expect(cookie).toMatch(/HttpOnly/);
    expect(cookie).toMatch(/SameSite=Lax/);
    expect(cookie).toMatch(/Path=\/ui/);
    expect(cookie).not.toMatch(/Secure/);
    const sessionId = browser.cookies.get("hl_session")!;
    expect(sessionId).toMatch(/^[A-Za-z0-9_-]{43}$/);
    // Stored hashed, for the new user, which the login created.
    const alice = hub.store.getUserByKey("github", "1")!;
    expect(alice.login).toBe("alice");
    const rows = hub.store.db.prepare("SELECT * FROM ui_sessions").all() as Record<string, unknown>[];
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id_hash: createHash("sha256").update(sessionId).digest("hex"), user_id: alice.id });
    expect((rows[0]!.expires_at as number) - (rows[0]!.created_at as number)).toBe(12 * HOUR);
    const { html } = await page(hub, browser);
    expect(html).toContain("alice");
  });

  it("enforces the allowlist with a plain access-denied page", async () => {
    const hub = await startHub(ctx, { allowedUsers: ["github:alice"] });
    await uiLogin(hub, browser);
    const bob = new Browser();
    const upstream = await startUiLogin(hub, bob);
    const res = await callback(hub, bob, { code: "code-bob", state: upstream.searchParams.get("state")! });
    expect(res.status).toBe(403);
    expect((await res.text()).toLowerCase()).toContain("access denied");
    expect(bob.cookies.has("hl_session")).toBe(false);
    expect(hub.store.getUserByKey("github", "2")).toBeNull();
  });

  it("uses each UI state once and only in the browser that started it", async () => {
    const hub = await startHub(ctx);
    const upstream = await startUiLogin(hub, browser);
    const state = upstream.searchParams.get("state")!;
    const other = new Browser();
    expect((await callback(hub, other, { code: "code-alice", state })).status).toBe(400);
    expect(other.cookies.has("hl_session")).toBe(false);
    expect((await callback(hub, browser, { code: "code-alice", state })).status).toBe(302);
    browser.cookies.delete("hl_session");
    expect((await callback(hub, browser, { code: "code-alice", state })).status).toBe(400);
    expect(browser.cookies.has("hl_session")).toBe(false);
  });

  it("logs out: deletes the session and clears the cookie", async () => {
    const hub = await startHub(ctx);
    await uiLogin(hub, browser);
    const sessionId = browser.cookies.get("hl_session")!;
    const res = await post(hub, browser, "/ui/logout");
    expect(res.status).toBe(303);
    expect(browser.cookies.has("hl_session")).toBe(false);
    expect(hub.store.db.prepare("SELECT count(*) AS n FROM ui_sessions").get()).toEqual({ n: 0 });
    // The old id is dead even if replayed.
    const replay = await fetch(`${hub.url}/ui`, { headers: { cookie: `hl_session=${sessionId}` }, redirect: "manual" });
    expect(replay.status).toBe(303);
  });

  it("expires sessions after 12 hours", async () => {
    const hub = await startHub(ctx);
    await uiLogin(hub, browser);
    hub.advance(12 * HOUR - 60_000);
    expect((await browser.request(`${hub.url}/ui`)).status).toBe(200);
    hub.advance(2 * 60_000);
    const res = await browser.request(`${hub.url}/ui`);
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/ui/login");
  });
});

describe("CSRF and headers", () => {
  it("refuses POSTs with a missing or wrong CSRF token", async () => {
    const hub = await startHub(ctx);
    await uiLogin(hub, browser);
    expect((await browser.postForm(`${hub.url}/ui/pair`, {})).status).toBe(403);
    expect((await browser.postForm(`${hub.url}/ui/pair`, { csrf: "wrong" })).status).toBe(403);
    // Another session's token does not work either.
    const bob = new Browser();
    await uiLogin(hub, bob, "code-bob");
    const { csrf: bobCsrf } = await page(hub, bob);
    expect((await browser.postForm(`${hub.url}/ui/pair`, { csrf: bobCsrf })).status).toBe(403);
    expect((await post(hub, browser, "/ui/pair")).status).toBe(200);
  });

  it("refuses POSTs from a foreign Origin", async () => {
    const hub = await startHub(ctx);
    await uiLogin(hub, browser);
    const { csrf } = await page(hub, browser);
    const foreign = await browser.postForm(`${hub.url}/ui/pair`, { csrf }, { origin: "https://evil.example" });
    expect(foreign.status).toBe(403);
    const same = await browser.postForm(`${hub.url}/ui/pair`, { csrf }, { origin: hub.url });
    expect(same.status).toBe(200);
  });

  it("sends the security headers on every /ui response, and no script", async () => {
    const hub = await startHub(ctx);
    const check = (res: Response) => {
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect(res.headers.get("content-security-policy")).toBe(
        "default-src 'none'; style-src 'self'; img-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
      );
      expect(res.headers.get("x-frame-options")).toBe("DENY");
      expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    };
    check(await browser.request(`${hub.url}/ui`));
    check(await browser.request(`${hub.url}/ui/login`));
    const css = await browser.request(`${hub.url}/ui/style.css`);
    check(css);
    expect(css.headers.get("content-type")).toContain("text/css");
    await uiLogin(hub, browser);
    for (const path of ["/ui", "/ui/jobs", "/ui/tokens"]) {
      const res = await browser.request(`${hub.url}${path}`);
      check(res);
      const html = await res.text();
      expect(html).not.toMatch(/<script/i);
      expect(html).toContain('href="/ui/style.css"');
    }
    check(await post(hub, browser, "/ui/pair"));
  });

  it("escapes a hostile machine name", async () => {
    const hub = await startHub(ctx);
    const alice = await uiLogin(hub, browser);
    await pair(hub, alice, `<img src=x onerror="alert(1)">&'`);
    const { html } = await page(hub, browser);
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;&amp;&#39;");
  });
});

describe("machines", () => {
  it("shows a pairing code once, with the agent command, that /pair accepts", async () => {
    const hub = await startHub(ctx);
    await uiLogin(hub, browser);
    const res = await post(hub, browser, "/ui/pair");
    expect(res.status).toBe(200);
    const html = await res.text();
    const code = /([0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4})/.exec(html)![1]!;
    expect(html).toContain(`hoistline-agent pair ${hub.url} ${code}`);
    const pairRes = await fetch(`${hub.url}/pair`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        code,
        name: "desk",
        publicKey: (await import("node:crypto"))
          .generateKeyPairSync("ed25519")
          .publicKey.export({ format: "der", type: "spki" })
          .toString("base64url"),
      }),
    });
    expect(pairRes.status).toBe(200);
    expect((await page(hub, browser)).html).toContain("desk");
  });

  it("lists my machines with status and runners, and machines shared with me with their owner", async () => {
    const hub = await startHub(ctx);
    const alice = await uiLogin(hub, browser);
    const bobBrowser = new Browser();
    const bob = await uiLogin(hub, bobBrowser, "code-bob");
    const laptop = await pair(hub, alice, "laptop");
    await pair(hub, alice, "desktop");
    const bobBox = await pair(hub, bob, "bobbox");
    await onlineAgent(hub, ctx, laptop);
    hub.store.shareMachine(bob.id, bobBox.machineId, "github:alice");
    hub.store.shareMachine(alice.id, laptop.machineId, "github:bob");
    const { html } = await page(hub, browser);
    const mine = html.slice(html.indexOf("My machines"), html.indexOf("Shared with me"));
    const shared = html.slice(html.indexOf("Shared with me"));
    expect(mine).toMatch(/laptop[\s\S]*online[\s\S]*muse[\s\S]*bob/);
    expect(mine).toMatch(/desktop[\s\S]*offline/);
    expect(shared).toMatch(/bobbox[\s\S]*bob[\s\S]*offline/);
  });

  it("shares by login: the machine appears in the grantee's list_machines", async () => {
    const hub = await startHub(ctx);
    const alice = await uiLogin(hub, browser);
    const bobBrowser = new Browser();
    await uiLogin(hub, bobBrowser, "code-bob");
    const laptop = await pair(hub, alice, "laptop");
    const res = await post(hub, browser, "/ui/share", { machineId: laptop.machineId, login: "bob" });
    expect(res.status).toBe(303);
    const bobClient = await mcpClient(hub, ctx, await createPat(hub, bobBrowser));
    const out = await bobClient.callTool({ name: "list_machines", arguments: {} });
    expect((out.structuredContent as { machines: { name: string; owner: string }[] }).machines).toEqual([
      expect.objectContaining({ name: "laptop", owner: "alice", shared: true }),
    ]);
    // Unknown logins are refused.
    expect((await post(hub, browser, "/ui/share", { machineId: laptop.machineId, login: "nobody" })).status).toBe(400);
  });

  it("never lets a grantee share or unshare, and hides other machines", async () => {
    const hub = await startHub(ctx);
    const alice = await uiLogin(hub, browser);
    const bobBrowser = new Browser();
    const bob = await uiLogin(hub, bobBrowser, "code-bob");
    const carolBrowser = new Browser();
    await uiLogin(hub, carolBrowser, "code-carol");
    const laptop = await pair(hub, alice, "laptop");
    hub.store.shareMachine(alice.id, laptop.machineId, "github:bob");
    const share = await post(hub, bobBrowser, "/ui/share", { machineId: laptop.machineId, login: "carol" });
    expect(share.status).toBe(403);
    const unshare = await post(hub, bobBrowser, "/ui/unshare", { machineId: laptop.machineId, target: `user:${bob.id}` });
    expect(unshare.status).toBe(403);
    expect(hub.store.listShares(alice.id, laptop.machineId).map((s) => s.login)).toEqual(["bob"]);
    // A stranger sees nothing.
    expect((await post(hub, carolBrowser, "/ui/share", { machineId: laptop.machineId, login: "carol" })).status).toBe(404);
    expect((await post(hub, carolBrowser, `/ui/machines/${laptop.machineId}/delete`, { confirm: "laptop" })).status).toBe(404);
    expect((await post(hub, browser, "/ui/share", { machineId: "nope", login: "bob" })).status).toBe(404);
  });

  it("unshare cancels the grantee's active jobs on that machine", async () => {
    const hub = await startHub(ctx);
    const alice = await uiLogin(hub, browser);
    const bobBrowser = new Browser();
    const bob = await uiLogin(hub, bobBrowser, "code-bob");
    const laptop = await pair(hub, alice, "laptop");
    const agent = await onlineAgent(hub, ctx, laptop);
    hub.store.shareMachine(alice.id, laptop.machineId, "github:bob");
    const job = hub.jobs.delegate(bob.id, { machine: laptop.machineId, ...delegateArgs });
    const own = hub.jobs.delegate(alice.id, { machine: laptop.machineId, ...delegateArgs });
    const res = await post(hub, browser, "/ui/unshare", { machineId: laptop.machineId, target: `user:${bob.id}` });
    expect(res.status).toBe(303);
    expect(hub.jobs.status(bob.id, job.id)).toBe("cancelled");
    expect(hub.jobs.status(alice.id, own.id)).toBe("queued");
    await waitFor(() => agent.messages.some((m) => m.type === "job.cancel" && m.jobId === job.id), "job.cancel");
    expect(hub.store.machinesFor(bob.id)).toEqual([]);
  });

  it("deletes a machine only with its name confirmed: cancels jobs, disconnects the agent, which cannot reconnect", async () => {
    const hub = await startHub(ctx);
    const alice = await uiLogin(hub, browser);
    const bob = await uiLogin(hub, new Browser(), "code-bob");
    const laptop = await pair(hub, alice, "laptop");
    const agent = await onlineAgent(hub, ctx, laptop);
    hub.store.shareMachine(alice.id, laptop.machineId, "github:bob");
    const job = hub.jobs.delegate(bob.id, { machine: laptop.machineId, ...delegateArgs });
    agent.send({ type: "job.event", jobId: job.id, stream: "status", data: "running" });
    await waitFor(() => hub.jobs.status(bob.id, job.id) === "running", "running");

    expect((await post(hub, browser, `/ui/machines/${laptop.machineId}/delete`)).status).toBe(400);
    expect((await post(hub, browser, `/ui/machines/${laptop.machineId}/delete`, { confirm: "Laptop" })).status).toBe(400);
    expect(hub.gateway.isOnline(laptop.machineId)).toBe(true);

    const res = await post(hub, browser, `/ui/machines/${laptop.machineId}/delete`, { confirm: "laptop" });
    expect(res.status).toBe(303);
    await waitFor(() => agent.closeCode !== undefined, "agent disconnected");
    expect(agent.messages.some((m) => m.type === "job.cancel" && m.jobId === job.id)).toBe(true);
    expect(hub.store.getMachineById(laptop.machineId)).toBeNull();
    expect(hub.store.machinesFor(bob.id)).toEqual([]);
    expect(hub.store.activeJobs()).toEqual([]);
    expect((await page(hub, browser)).html).not.toContain("laptop");

    const again = new RawAgent(hub, ctx);
    await again.hello(laptop.machineId, laptop.privateKey);
    await waitFor(() => again.closeCode !== undefined, "reconnect refused");
    expect(again.closeCode).toBe(4401);
    expect(hub.gateway.isOnline(laptop.machineId)).toBe(false);
  });
});

describe("jobs", () => {
  async function setup() {
    const hub = await startHub(ctx);
    const alice = await uiLogin(hub, browser);
    const bobBrowser = new Browser();
    const bob = await uiLogin(hub, bobBrowser, "code-bob");
    const carolBrowser = new Browser();
    await uiLogin(hub, carolBrowser, "code-carol");
    const laptop = await pair(hub, alice, "laptop");
    const agent = await onlineAgent(hub, ctx, laptop);
    hub.store.shareMachine(alice.id, laptop.machineId, "github:bob");
    return { hub, alice, bob, bobBrowser, carolBrowser, laptop, agent };
  }

  it("lists my jobs and shared users' jobs on my machines, with the requester's login", async () => {
    const { hub, alice, bob, bobBrowser, laptop } = await setup();
    const bobJob = hub.jobs.delegate(bob.id, { machine: laptop.machineId, ...delegateArgs, runner: "codex" });
    hub.store.updateJob(bobJob.id, { status: "failed", reason: "approval_unavailable" });
    const own = hub.jobs.delegate(alice.id, { machine: laptop.machineId, ...delegateArgs });
    const { html } = await page(hub, browser, "/ui/jobs");
    expect(html).toContain(own.id);
    expect(html).toContain(bobJob.id);
    expect(html).toMatch(new RegExp(`${bobJob.id}[\\s\\S]*bob[\\s\\S]*codex[\\s\\S]*failed`));
    expect(html).toContain("the machine could not record the approval request (approval queue unavailable)");
    // Bob sees only his own job.
    const bobView = (await page(hub, bobBrowser, "/ui/jobs")).html;
    expect(bobView).toContain(bobJob.id);
    expect(bobView).not.toContain(own.id);
  });

  it("lets the submitter and the machine owner cancel; anyone else gets 404", async () => {
    const { hub, alice, bob, bobBrowser, carolBrowser, laptop } = await setup();
    const a = hub.jobs.delegate(bob.id, { machine: laptop.machineId, ...delegateArgs });
    const b = hub.jobs.delegate(bob.id, { machine: laptop.machineId, ...delegateArgs });
    const own = hub.jobs.delegate(alice.id, { machine: laptop.machineId, ...delegateArgs });
    expect((await post(hub, carolBrowser, `/ui/jobs/${a.id}/cancel`)).status).toBe(404);
    expect((await post(hub, bobBrowser, `/ui/jobs/${own.id}/cancel`)).status).toBe(404);
    expect((await post(hub, browser, "/ui/jobs/nope/cancel")).status).toBe(404);
    expect(hub.jobs.status(bob.id, a.id)).toBe("queued");

    expect((await post(hub, bobBrowser, `/ui/jobs/${a.id}/cancel`)).status).toBe(303);
    expect(hub.jobs.status(bob.id, a.id)).toBe("cancelled");
    expect((await post(hub, browser, `/ui/jobs/${b.id}/cancel`)).status).toBe(303);
    expect(hub.jobs.status(bob.id, b.id)).toBe("cancelled");
    expect((await post(hub, browser, `/ui/jobs/${own.id}/cancel`)).status).toBe(303);
    expect(hub.jobs.status(alice.id, own.id)).toBe("cancelled");
  });

  it("escapes job prompts and reasons", async () => {
    const { hub, alice, laptop } = await setup();
    const job = hub.jobs.delegate(alice.id, { machine: laptop.machineId, ...delegateArgs, prompt: "<b>prompt</b>" });
    hub.store.updateJob(job.id, { status: "failed", reason: "<i>reason</i>" });
    const { html } = await page(hub, browser, "/ui/jobs");
    expect(html).not.toContain("<i>reason</i>");
    expect(html).toContain("&lt;i&gt;reason&lt;/i&gt;");
    expect(html).not.toContain("<b>prompt</b>");
  });
});

describe("reason wording", () => {
  it("describes approval reasons", () => {
    expect(describeReason("approval_unavailable")).toBe(
      "the machine could not record the approval request (approval queue unavailable)",
    );
    expect(describeReason("approval_denied")).toBe("the machine's owner denied this job");
    expect(describeReason("runner_exit_3")).toBeUndefined();
  });

  it("task_status shows the approval wording", async () => {
    const hub = await startHub(ctx);
    const alice = await uiLogin(hub, browser);
    const laptop = await pair(hub, alice, "laptop");
    await onlineAgent(hub, ctx, laptop);
    const job = hub.jobs.delegate(alice.id, { machine: laptop.machineId, ...delegateArgs });
    hub.store.updateJob(job.id, { status: "failed", reason: "approval_denied" });
    const client = await mcpClient(hub, ctx, await createPat(hub, browser));
    for (const name of ["task_status", "task_result"]) {
      const out = await client.callTool({ name, arguments: { jobId: job.id } });
      expect(JSON.stringify(out.content)).toContain("the machine's owner denied this job");
    }
  });
});
