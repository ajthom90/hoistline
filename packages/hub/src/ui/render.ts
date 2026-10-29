import { escapeHtml } from "../auth/login-flow.js";

/** Escapes every interpolated value; anything from users or agents is untrusted. */
export const h = (value: string | number): string => escapeHtml(String(value));

export const STYLE_CSS = `body { font: 15px/1.5 system-ui, sans-serif; max-width: 64rem; margin: 2rem auto; padding: 0 1rem; color: #1a1a1a; background: #fff; }
nav { display: flex; gap: 1rem; align-items: center; border-bottom: 1px solid #ddd; padding-bottom: .5rem; margin-bottom: 1rem; }
nav .who { margin-left: auto; color: #555; }
nav form { display: inline; }
table { border-collapse: collapse; width: 100%; margin: .5rem 0 1.5rem; }
th, td { text-align: left; padding: .35rem .5rem; border-bottom: 1px solid #eee; vertical-align: top; }
code, .mono { font-family: ui-monospace, monospace; word-break: break-all; }
.secret { display: block; padding: .75rem; background: #f6f6f6; border: 1px solid #ddd; margin: .5rem 0; }
.online { color: #116611; }
.offline { color: #888; }
.error { color: #a00; }
.muted { color: #666; }
form.inline { display: inline; margin: 0; }
input, button { font: inherit; }
button { cursor: pointer; }
`;

/** A form that POSTs with the session's CSRF token. */
export function form(action: string, csrf: string, inner: string, cls = "inline"): string {
  return `<form class="${cls}" method="post" action="${h(action)}"><input type="hidden" name="csrf" value="${h(csrf)}">${inner}</form>`;
}

export function hidden(name: string, value: string): string {
  return `<input type="hidden" name="${h(name)}" value="${h(value)}">`;
}

/** Unix milliseconds as `YYYY-MM-DD HH:MM UTC`. */
export function when(ms: number | undefined): string {
  if (ms === undefined) return "never";
  return `${new Date(ms).toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

export function page(opts: { title: string; body: string; user?: { login: string }; csrf?: string }): string {
  const nav =
    opts.user && opts.csrf
      ? `<nav><a href="/ui">Machines</a><a href="/ui/jobs">Jobs</a><a href="/ui/tokens">Access tokens</a>` +
        `<span class="who">${h(opts.user.login || "(no login)")}</span>` +
        `${form("/ui/logout", opts.csrf, "<button type=\"submit\">Log out</button>")}</nav>`
      : "";
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${h(opts.title)} - Hoistline</title>
<link rel="stylesheet" href="/ui/style.css">
</head>
<body>
${nav}
<h1>${h(opts.title)}</h1>
${opts.body}
</body>
</html>
`;
}
