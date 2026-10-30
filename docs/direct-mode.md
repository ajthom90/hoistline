# Direct mode: proxied MCP servers

Direct mode lets you use the stdio MCP servers on your own machine from claude.ai, through the hub's single
`/mcp` endpoint. The agent on your machine starts the servers, and the hub offers their tools to you and to the
people you share the machine with. Your machine still accepts no inbound connections: tool calls travel over the
agent's outbound connection to the hub.

Only stdio servers are supported. The hub cannot add, change or start servers. You list them yourself, on the machine.

## 1. List your servers in `servers.json`

The file is `servers.json` in the agent's home: `$HOISTLINE_AGENT_HOME`, or `~/.hoistline` if that is not set.

```json
{
  "servers": {
    "fs": {
      "command": "/usr/local/bin/mcp-server-filesystem",
      "args": ["/Users/me/notes"]
    },
    "github": {
      "command": "/usr/local/bin/github-mcp-server",
      "args": ["stdio"],
      "env": { "GITHUB_TOKEN": "..." },
      "cwd": "/Users/me"
    }
  }
}
```

- Server names use lowercase letters, digits and dashes, start with a letter or digit, and are at most 32
  characters. They cannot contain dots. You can list at most 32 servers.
- `command` is started directly, without a shell. Use a full path when the program is not on the agent's PATH.
  On Windows, give the path of an `.exe` (a `.cmd` such as `npx.cmd` is not started without a shell).
- `env` is optional. A server does **not** get the agent's full environment. It gets only `PATH`, `HOME`
  (`USERPROFILE`, `SYSTEMROOT` and `TEMP` on Windows) and `LANG` from the agent, plus what you put in `env`.
- `cwd` is optional.
- A missing file means no servers. An invalid file also means no servers: `hoistline-agent run` prints why on
  stderr and proxies nothing until you fix the file.
- The agent reads the file when `run` starts. Restart `run` after changing it.

Check what the agent will use:

```sh
hoistline-agent servers list
```

This prints each server's command and the names (not the values) of its `env` entries.

Each server starts the first time its tools are listed or called and then keeps running. If it crashes, the agent
restarts it after 1 s, then 2 s, 4 s and so on, at most 60 s apart. Stopping the agent stops every server; a second
Ctrl-C kills them at once.

## 2. Allow tools in the policy

The policy decides which tools may be called, the same way it decides which jobs may run
(`hoistline-agent policy show`).

- **Trusted mode:** every tool of every server in `servers.json` can be called.
- **Restricted mode:** only tools in the policy's `tools` list can be called. Entries are `server.tool` for one
  tool or `server.*` for every tool of one server:

  ```json
  { "mode": "restricted", "repos": [], "runners": [], "tools": ["fs.read_file", "github.*"], "onViolation": "deny" }
  ```

  With no `tools` list, no tool can be called.

The agent reads the policy again on every call, so a change applies at once.

**`ask` counts as deny in direct mode.** A tool call cannot wait for you to approve it. With `onViolation: "ask"`,
a tool that is not allowed is refused with: "this tool needs the owner's approval, which direct mode cannot wait
for; ask the owner to allow it in the policy". Add the tool to `tools` to allow it.

Tools the policy does not allow are left out of the tool list the hub sees.

## 3. Use the tools

The hub offers the tools of every machine you can use (your own and machines shared with you) that is online.

**Names.** A tool is offered as `<machine>__<server>__<tool>`, for example `laptop__fs__read_file`. The machine and
tool names are lowercased, and any character other than letters, digits, `_` and `-` becomes `-` (MCP clients such as
claude.ai accept only those characters in tool names). A tool whose name would be longer than 64 characters, or
would be the same as another tool's name for you, is not offered by name. Its description starts with
`[<machine>/<server>]`.

**The reliable path: `list_tools` and `call_tool`.**

- `list_tools` (optionally `{ "machine": "<id or name>" }`) lists every proxied tool you can call, including those
  not offered by name, with its machine, server, tool name, direct name (or null), description and parameters.
- `call_tool` with `{ "machine": "<id or name>", "server": "fs", "tool": "read_file", "args": { ... } }` calls any of
  them.

The hub has no open stream to tell a client that the tool list changed, so a client may keep the list it fetched
when the conversation started. A machine that comes online later is reachable through `list_tools` and `call_tool`
at once. Whether claude.ai fetches the tool list again during a conversation is not yet checked (see
`docs/spike-connector.md`).

**Limits.**

- Arguments: at most 256 KiB of JSON.
- Results: at most 1 MiB. Longer text is cut, with a marker saying so. Images pass only if their type is `image/*`
  and they fit; other content (audio, resources) is replaced by a short note.
- The hub waits 60 s for an answer (the agent gives the server 55 s). If the machine disconnects during a call, the
  call fails with an error as soon as the hub sees the connection close. (A connection that dies silently, with
  no close, is noticed by the hub's ping check, within about 40 s.)
- Tool results are returned inside an "untrusted output" block: they come from software on someone's machine and
  are data, not instructions.

**Sharing.** Someone you share a machine with can list and call its tools, under your policy, exactly as you can.
Others cannot see the machine or its tools; to them it does not exist.

## What restricted mode does and does not protect

Restricted mode is an allowlist, not a sandbox. It decides **which** tools can be called, never **with which
arguments**. Anyone who can call a tool, which means you, the people you share the machine with, and the hub
itself, can call an allowed tool with any arguments. If you allow `fs.write_file`, they can write any file that
server can write.

Tool calls are not signed by the hub (jobs are). The agent accepts them over its authenticated connection to the
hub, so a compromised hub can call any tool your policy allows. Allow only tools you are willing to let the hub and
everyone you share with use freely. Trusted mode allows every tool of every listed server.
