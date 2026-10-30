import express, { type Request, type RequestHandler, type Response } from "express";
import { parseCookies, safeEqual, serializeCookie } from "./auth/cookies.js";
import { userKey, type UserIdentity } from "./auth/identity.js";
import type { LoginFlow } from "./auth/login-flow.js";
import { CLOSE_AUTH_FAILED, type Gateway } from "./gateway.js";
import { describeReason, type Jobs } from "./jobs.js";
import { ACTIVE_JOB_STATUSES, type Store, type User } from "./store.js";
import { AccessTokens, PAT_DEFAULT_DAYS, PAT_MAX_DAYS, TokenRequestError } from "./tokens.js";
import { SECURITY_HEADERS } from "./ui/headers.js";
import { form, h, hidden, page, STYLE_CSS, when } from "./ui/render.js";
import { SESSION_COOKIE, SESSION_TTL_MS, UiSessions, type UiSession } from "./ui/session.js";

export interface UiDeps {
  store: Store;
  gateway: Gateway;
  jobs: Jobs;
  tokens: AccessTokens;
  sessions: UiSessions;
  login: LoginFlow;
  /** The hub's shared allowlist re-check (also used for access tokens): whether the user may still use the hub. */
  allowed: (user: User) => boolean;
  /** The hub's public base URL as configured (no trailing slash). */
  publicUrl: string;
  /** For OIDC hubs, the users-table provider (`oidc:<issuer>`); shares then resolve to existing users only. */
  oidcProvider?: string;
}

const ACTIVE: readonly string[] = ACTIVE_JOB_STATUSES;

interface Ctx {
  user: User;
  session: UiSession;
  sessionId: string;
}

const ctxOf = (res: Response) => res.locals.ui as Ctx;
const field = (req: Request, name: string): string | undefined => {
  const value = (req.body as Record<string, unknown> | undefined)?.[name];
  return typeof value === "string" ? value : undefined;
};
const param = (req: Request, name: string): string => String(req.params[name] ?? "");

/** An error the user sees with this status and message (escaped). */
class UiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}
const notFound = () => new UiError(404, "Not found.");

function isSecure(publicUrl: string): boolean {
  return new URL(publicUrl).protocol === "https:";
}

/**
 * Completes a web UI login (LoginFlow.onUiLogin): opens a session for the hub user the login just recorded, sets the
 * hl_session cookie and lands on /ui.
 */
export function uiLoginHandler(store: Store, sessions: UiSessions, publicUrl: string) {
  return (identity: UserIdentity, res: Response): void => {
    const key = userKey(identity);
    const user = key && store.getUserByKey(key.provider, key.subject);
    if (!user) throw new Error("the hub could not find the user that just logged in");
    // The browser's previous session (whoever it belonged to) ends: one live session per browser.
    const previous = parseCookies(res.req.headers.cookie).get(SESSION_COOKIE);
    if (previous) sessions.delete(previous);
    const { id } = sessions.create(user.id);
    res.append(
      "Set-Cookie",
      serializeCookie(SESSION_COOKIE, id, { secure: isSecure(publicUrl), maxAge: SESSION_TTL_MS / 1000, path: "/ui" }),
    );
    res.redirect(302, "/ui");
  };
}

/** The hub's server-rendered web UI under /ui: machines, pairing, sharing, jobs and personal access tokens. */
export function uiRouter(deps: UiDeps): express.Router {
  const { store, gateway, jobs, tokens, sessions, login } = deps;
  const origin = new URL(deps.publicUrl).origin;
  const secure = isSecure(deps.publicUrl);
  const router = express.Router();

  router.use("/ui", (_req, res, next) => {
    res.set(SECURITY_HEADERS);
    next();
  });
  router.get("/ui/style.css", (_req, res) => {
    res.type("text/css").send(STYLE_CSS);
  });
  router.get("/ui/login", async (_req, res, next) => {
    try {
      await login.startUi(res);
    } catch (err) {
      next(err);
    }
  });

  // Everything else needs a live session.
  const requireSession: RequestHandler = (req, res, next) => {
    const sessionId = parseCookies(req.headers.cookie).get(SESSION_COOKIE);
    const session = sessions.get(sessionId);
    const user = session && store.getUser(session.userId);
    if (!sessionId || !session || !user) {
      res.redirect(303, "/ui/login");
      return;
    }
    // A user removed from the allowlist loses the UI at once, like their access tokens.
    if (!deps.allowed(user)) {
      sessions.delete(sessionId);
      res.append("Set-Cookie", serializeCookie(SESSION_COOKIE, "", { secure, maxAge: 0, path: "/ui" }));
      res.redirect(303, "/ui/login");
      return;
    }
    res.locals.ui = { user, session, sessionId } satisfies Ctx;
    next();
  };
  // POSTs: the session's CSRF token, and a same-origin Origin header when one is sent.
  const checkPost: RequestHandler = (req, res, next) => {
    const { session } = ctxOf(res);
    const csrf = field(req, "csrf");
    const sentOrigin = req.headers.origin;
    if (!csrf || !safeEqual(csrf, session.csrf) || (sentOrigin !== undefined && sentOrigin !== origin)) {
      throw new UiError(403, "Forbidden: the form was stale or did not come from this hub. Reload the page and try again.");
    }
    next();
  };
  // Mounted by prefix, which Express matches case-insensitively for every method, like the routes below: no spelling of
  // a /ui path reaches a route without a session, nor a POST without its CSRF and Origin checks.
  const parseForm = express.urlencoded({ extended: false, limit: "16kb" });
  router.use("/ui", requireSession, (req, res, next) => {
    if (req.method !== "POST") return next();
    parseForm(req, res, (err?: unknown) => {
      if (err) return next(err);
      try {
        checkPost(req, res, next);
      } catch (e) {
        next(e);
      }
    });
  });

  const render = (res: Response, title: string, body: string, status = 200) => {
    const { user, session } = ctxOf(res);
    res.status(status).type("html").send(page({ title, body, user, csrf: session.csrf }));
  };

  /** A machine the caller can see (404 otherwise); with `owner`, also one they own (403 for a grantee). */
  const machineFor = (res: Response, machineId: string, owner: boolean) => {
    const { user } = ctxOf(res);
    const machine = store.getMachine(user.id, machineId);
    if (!machine) throw notFound();
    if (owner && machine.ownerId !== user.id) throw new UiError(403, "Only the machine's owner can do that.");
    return machine;
  };

  const machinesPage = (res: Response, notice = "") => {
    const { user, session } = ctxOf(res);
    const csrf = session.csrf;
    const all = store.machinesFor(user.id);
    const mine = all.filter((m) => m.ownerId === user.id);
    const shared = all.filter((m) => m.ownerId !== user.id);
    const status = (id: string) =>
      gateway.isOnline(id) ? `<span class="online">online</span>` : `<span class="offline">offline</span>`;
    const mineRows = mine.map((m) => {
      const runners = gateway.agentInfo(m.id)?.runners ?? [];
      const shares = store.listShares(user.id, m.id).map(
        (s) =>
          `<div>${h(s.login || "(no login)")} ` +
          form("/ui/unshare", csrf, hidden("machineId", m.id) + hidden("target", `user:${s.userId}`) + `<button type="submit">Unshare</button>`) +
          `</div>`,
      );
      const share = form(
        "/ui/share",
        csrf,
        hidden("machineId", m.id) +
          `<input name="login" required maxlength="100" placeholder="${deps.oidcProvider ? "user:&lt;id&gt;" : "GitHub login"}"> <button type="submit">Share</button>`,
      );
      const del = form(
        `/ui/machines/${m.id}/delete`,
        csrf,
        `<input name="confirm" required maxlength="100" placeholder="type the machine name"> <button type="submit">Delete</button>`,
      );
      return (
        `<tr><td>${h(m.name)}<div class="muted mono">${h(m.id)}</div></td><td class="muted">not reported</td><td>${status(m.id)}</td>` +
        `<td>${runners.length ? h(runners.join(", ")) : `<span class="muted">none</span>`}</td>` +
        `<td>${shares.join("")}${share}</td><td>${del}</td></tr>`
      );
    });
    const sharedRows = shared.map(
      (m) => `<tr><td>${h(m.name)}</td><td>${h(store.getUser(m.ownerId)?.login || "(no login)")}</td><td>${status(m.id)}</td></tr>`,
    );
    const shareId = deps.oidcProvider
      ? `<p class="muted">Others share machines with you by your id: <code>user:${h(user.id)}</code>.</p>`
      : "";
    const body =
      notice +
      `<h2>My machines</h2>` +
      (mineRows.length
        ? `<table><tr><th>Name</th><th>OS</th><th>Status</th><th>Runners</th><th>Shared with</th><th>Delete</th></tr>${mineRows.join("")}</table>` +
          `<p class="muted">Deleting a machine cancels its jobs, disconnects its agent and removes its key; the agent must pair again.</p>`
        : `<p class="muted">No machines yet.</p>`) +
      `<h2>Pair a machine</h2>` +
      form("/ui/pair", csrf, `<button type="submit">Create a pairing code</button>`, "") +
      shareId +
      `<h2>Shared with me</h2>` +
      (sharedRows.length
        ? `<table><tr><th>Name</th><th>Owner</th><th>Status</th></tr>${sharedRows.join("")}</table>`
        : `<p class="muted">Nothing is shared with you.</p>`);
    render(res, "Machines", body);
  };

  router.get("/ui", (_req, res) => machinesPage(res));

  router.post("/ui/pair", (_req, res) => {
    const { user } = ctxOf(res);
    const code = store.createPairingCode(user.id);
    const notice =
      `<h2>Pairing code</h2><p>Run this on the machine within 10 minutes. The code works once and is not shown again.</p>` +
      `<code class="secret">hoistline-agent pair ${h(deps.publicUrl)} ${h(code)}</code>`;
    machinesPage(res, notice);
  });

  router.post("/ui/share", (req, res) => {
    const machine = machineFor(res, field(req, "machineId") ?? "", true);
    const login = (field(req, "login") ?? "").trim();
    if (!login || login.length > 100) throw new UiError(400, "Enter the login to share with.");
    const target = shareTarget(login);
    try {
      store.shareMachine(ctxOf(res).user.id, machine.id, target);
    } catch (err) {
      throw new UiError(400, err instanceof Error ? err.message : String(err));
    }
    res.redirect(303, "/ui");
  });

  /** The store's share target: `github:<login>` on GitHub hubs; on OIDC hubs an existing user only, as `user:<id>`. */
  const shareTarget = (login: string): string => {
    if (!deps.oidcProvider) return `github:${login}`;
    return login.startsWith("user:") ? login : `user:${login}`;
  };

  router.post("/ui/unshare", (req, res) => {
    const machine = machineFor(res, field(req, "machineId") ?? "", true);
    let revoked: User;
    try {
      revoked = store.unshareMachine(ctxOf(res).user.id, machine.id, field(req, "target") ?? "");
    } catch (err) {
      throw new UiError(400, err instanceof Error ? err.message : String(err));
    }
    jobs.onShareRevoked(machine.id, revoked.id);
    res.redirect(303, "/ui");
  });

  router.post("/ui/machines/:id/delete", (req, res) => {
    const { user } = ctxOf(res);
    const machine = machineFor(res, param(req, "id"), true);
    if (field(req, "confirm") !== machine.name) {
      throw new UiError(400, "To delete the machine, type its name exactly in the confirmation field.");
    }
    jobs.cancelForDeletedMachine(user.id, machine.id);
    store.deleteMachine(user.id, machine.id);
    gateway.disconnect(machine.id, CLOSE_AUTH_FAILED);
    res.redirect(303, "/ui");
  });

  router.get("/ui/jobs", (_req, res) => {
    const { user, session } = ctxOf(res);
    const rows = store.jobsForOwnerOrSubmitter(user.id).map((j) => {
      const description = j.reason === undefined ? undefined : describeReason(j.reason);
      const reason =
        j.reason === undefined ? "" : `<span class="mono">${h(j.reason)}</span>${description ? `<div>${h(description)}</div>` : ""}`;
      const prompt = j.prompt.length > 120 ? `${j.prompt.slice(0, 120)}...` : j.prompt;
      const cancel = ACTIVE.includes(j.status)
        ? form(`/ui/jobs/${j.id}/cancel`, session.csrf, `<button type="submit">Cancel</button>`)
        : "";
      return (
        `<tr><td class="mono">${h(j.id)}<div class="muted">${h(prompt)}</div></td><td>${h(j.machineDeleted ? `${j.machineName} (deleted)` : j.machineName)}</td>` +
        `<td>${h(j.requesterLogin || "(no login)")}</td><td>${h(j.runner)}</td><td>${h(j.status)}</td>` +
        `<td>${h(when(j.createdAt))}</td><td>${reason}</td><td>${cancel}</td></tr>`
      );
    });
    const body = rows.length
      ? `<p class="muted">Jobs you submitted, and every job on machines you own.</p>` +
        `<table><tr><th>Job</th><th>Machine</th><th>Requester</th><th>Runner</th><th>Status</th><th>Created</th><th>Reason</th><th></th></tr>${rows.join("")}</table>`
      : `<p class="muted">No jobs yet.</p>`;
    render(res, "Jobs", body);
  });

  router.post("/ui/jobs/:id/cancel", (req, res) => {
    const { user } = ctxOf(res);
    const jobId = param(req, "id");
    if (store.getJob(user.id, jobId)) {
      jobs.cancel(user.id, jobId);
    } else {
      const job = store.getJobById(jobId);
      if (!job || store.getMachineById(job.machineId)?.ownerId !== user.id) throw notFound();
      jobs.cancelAsOwner(user.id, jobId);
    }
    res.redirect(303, "/ui/jobs");
  });

  const tokensPage = (res: Response, notice = "", status = 200) => {
    const { user, session } = ctxOf(res);
    const now = store.now();
    const rows = tokens.list(user.id).map(
      (t) =>
        `<tr><td>${h(t.name)}</td><td>${h(when(t.createdAt))}</td>` +
        `<td>${h(when(t.expiresAt))}${t.expiresAt <= now ? ` <span class="error">expired</span>` : ""}</td>` +
        `<td>${h(when(t.lastUsedAt))}</td>` +
        `<td>${form(`/ui/tokens/${t.id}/revoke`, session.csrf, `<button type="submit">Revoke</button>`)}</td></tr>`,
    );
    const body =
      notice +
      `<p>Personal access tokens let MCP clients that cannot sign in interactively use <code>${h(deps.publicUrl)}/mcp</code> ` +
      `as you, with <code>Authorization: Bearer &lt;token&gt;</code>. Treat them like passwords.</p>` +
      `<h2>Create a token</h2>` +
      form(
        "/ui/tokens",
        session.csrf,
        `<label>Name <input name="name" required maxlength="64"></label> ` +
          `<label>Days <input name="days" type="number" min="1" max="${PAT_MAX_DAYS}" value="${PAT_DEFAULT_DAYS}"></label> ` +
          `<button type="submit">Create</button>`,
        "",
      ) +
      `<h2>Your tokens</h2>` +
      (rows.length
        ? `<table><tr><th>Name</th><th>Created</th><th>Expires</th><th>Last used</th><th></th></tr>${rows.join("")}</table>`
        : `<p class="muted">No tokens.</p>`);
    render(res, "Access tokens", body, status);
  };

  router.get("/ui/tokens", (_req, res) => tokensPage(res));

  router.post("/ui/tokens", (req, res) => {
    const daysField = (field(req, "days") ?? "").trim();
    const days = daysField === "" ? PAT_DEFAULT_DAYS : /^\d{1,4}$/.test(daysField) ? Number(daysField) : NaN;
    let token: string;
    try {
      token = tokens.create(ctxOf(res).user.id, field(req, "name") ?? "", days).token;
    } catch (err) {
      if (err instanceof TokenRequestError) {
        return tokensPage(res, `<p class="error">Not created: ${h(err.message)}.</p>`, 400);
      }
      throw err;
    }
    tokensPage(
      res,
      `<h2>New token</h2><p>Copy it now: it is not shown again.</p><code class="secret">${h(token)}</code>`,
    );
  });

  router.post("/ui/tokens/:id/revoke", (req, res) => {
    if (!tokens.revoke(ctxOf(res).user.id, param(req, "id"))) throw notFound();
    res.redirect(303, "/ui/tokens");
  });

  router.post("/ui/logout", (_req, res) => {
    sessions.delete(ctxOf(res).sessionId);
    res.append("Set-Cookie", serializeCookie(SESSION_COOKIE, "", { secure, maxAge: 0, path: "/ui" }));
    res.redirect(303, "/ui/login");
  });

  router.use("/ui", () => {
    throw notFound();
  });

  // Errors under /ui (any case): a plain page, never details of internal failures.
  const onError: express.ErrorRequestHandler = (err, req, res, next) => {
    const path = req.originalUrl.split("?")[0] ?? "";
    if (res.headersSent || !/^\/ui(\/|$)/i.test(path)) return next(err);
    const status = err instanceof UiError ? err.status : typeof err?.status === "number" && err.status < 500 ? 400 : 500;
    const message = err instanceof UiError ? err.message : status === 500 ? "Something went wrong." : "Bad request.";
    const body = `<p class="error">${h(message)}</p><p><a href="/ui">Back</a></p>`;
    const title = status === 404 ? "Not found" : status === 403 ? "Forbidden" : "Error";
    res.set(SECURITY_HEADERS);
    if (res.locals.ui && status < 500) render(res, title, body, status);
    else res.status(status).type("html").send(page({ title, body }));
  };
  router.use(onError);

  return router;
}
