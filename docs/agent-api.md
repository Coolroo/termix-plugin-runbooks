---
title: Agent API and MCP
order: 1
---

# Agent API and MCP

An agent talks to Runbooks with a **Runbooks token**, over plain REST or over MCP. Both do the same things: list hosts, propose runbooks and steps, change steps that have not run, and read runbooks with every run and its output. Neither can run, skip or complete a step.

## Tokens

Make a token in Runbooks, **Agent tokens** (needs the Manage Runbooks tokens permission). Name it, tick the hosts it may use (at least one; only SSH hosts you can connect to), and press **Make token**. It starts with `rbk_` and is shown once. Send it on every request:

```
Authorization: Bearer rbk_...
```

What a token can reach:

- `list_hosts` returns only the hosts ticked for it, and steps may only name those hosts. Change the list later with **Hosts** on the token's row. A host that does not take SSH (a remote desktop host) is never listed, and a step that names one is refused with `host N is not an SSH host`.
- it sees only the runbooks made with tokens of the person who made it
- it stops working when it is revoked, or when that person loses the Use Runbooks permission

The host list says where an agent may propose commands. Whoever runs a step still needs connect access to its host.

Each token may make 120 requests a minute.

## Base URL

```
https://<your Termix address>/plugin-api/runbooks/agent
```

When Termix runs under a base path (`BASE_PATH`), put it before `/plugin-api`.

## REST

| Method and path               | What it does                                                      |
| ----------------------------- | ----------------------------------------------------------------- |
| `GET /hosts`                  | Hosts ticked for the token: `id`, `name`, `address`, `folder`     |
| `GET /runbooks?status=open`   | Runbooks with progress; `status` is `open`, `done` or `abandoned` |
| `POST /runbooks`              | Propose a runbook with steps (201)                                |
| `GET /runbooks/{id}`          | One runbook: steps, notes, every run and its output, newest first |
| `PATCH /runbooks/{id}`        | Change `title`, `summary`, `values` (the whole set) or `status`   |
| `POST /runbooks/{id}/steps`   | Add `steps`, at the end or at a 1-based `position` (201)          |
| `POST /runbooks/{id}/reorder` | `{ "stepIds": [...] }` with every step once                       |
| `GET /runbooks/{id}/values`   | Effective values and where each came from                         |
| `PATCH /steps/{id}`           | Change a step that has not run; only the given fields change      |
| `DELETE /steps/{id}`          | Remove a step that has not run                                    |
| `POST /mcp`                   | MCP (below)                                                       |

### A link for the person

Every runbook in an answer (list, read, create, change) has `openPath`, such as `/?view=runbook&id=12`. It is relative because Runbooks does not know the address people use. The person opens your Termix address followed by `openPath`, for example `https://termix.example.com/?view=runbook&id=12`, and the Runbooks tab opens on that runbook. A person who is signed out signs in first and then lands on it. When Termix runs under a base path, put the base path before `openPath`. Have the agent give the person that link for each runbook it makes.

Every change answers with the whole runbook, as `GET /runbooks/{id}` does. Errors are `{ "error": "..." }` with status 400 (bad input), 401 (token), 403, 404, 409 (the step already ran, or the runbook is not open) or 429 (rate limit).

### A step

| Field                      | Type            | What it is                                                                                  |
| -------------------------- | --------------- | ------------------------------------------------------------------------------------------- |
| `title`                    | string          | Required. Up to 200 characters.                                                             |
| `body`                     | markdown        | What to do and why, shown before the command.                                               |
| `hostId`                   | integer or null | A host from `/hosts`. Leave it out for a manual step (text only).                           |
| `command`                  | string or null  | The shell command. Needs `hostId`.                                                          |
| `expect`                   | markdown        | What the person should see when it works.                                                   |
| `captures`                 | array           | `[{ "name": "version", "pattern": "nginx/(\\S+)" }]`: values to take from standard output.  |
| `checks`                   | array           | Rules tested on the output when the run ends; see [Checks](#checks). At most 20.            |
| `hideOutputFromAgents`     | boolean         | Hide the output from agents. An agent can set it but not clear it.                          |
| `timeoutMs`                | integer or null | Time limit, 1000 to 600000. Default 120000.                                                 |
| `waitAfterPreviousSeconds` | integer or null | Seconds to wait after the previous step ended, 1 to 86400. See [Wait timers](#wait-timers). |
| `waitReason`               | string or null  | Why to wait, up to 500 characters. Needs `waitAfterPreviousSeconds`.                        |

A step that has run is history: changing it, removing it, or putting a step before it is refused with 409. Add a new step instead.

### Values and placeholders

`{{name}}` in a command is replaced by the value of `name`, as plain text, with no shell quoting. Values come from the runbook's `values` object first, then from captures of earlier steps in step order; a later value wins. Names match `[A-Za-z_][A-Za-z0-9_.-]*`. A step whose placeholders have no value cannot run, and its `missing` field names them.

A capture is a JavaScript regular expression, in multiline mode, with exactly one capturing group. It runs on the first 256 KB of standard output (or the pasted terminal output); the first match's group becomes the value.

### Checks

`expect` tells the person what to look for. A check makes Runbooks look for it: each check is tested on the run's full output when the run ends, and if any check fails the step is marked failed, even when the command exited 0. The person sees which check failed and why, and decides what to do next. A step without checks works as before: exit code 0 is done.

| Type                      | Fields                                                         | Passes when                                                                                 |
| ------------------------- | -------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `exitCode`                | `equals` (integer)                                             | the exit code is `equals`                                                                   |
| `contains`, `notContains` | `text`, `stream`                                               | the stream has (or does not have) `text`                                                    |
| `matches`, `notMatches`   | `pattern` (JavaScript regular expression, multiline), `stream` | the stream matches (or does not match) `pattern`                                            |
| `value`                   | `name` (a capture of this step), `equals` or `matches`         | the captured value equals `equals` or matches `matches`; with neither, that it was captured |

`stream` is `stdout`, `stderr` or `any` (the default: either one). Every check may have a `label`, which the person sees instead of a generated description. A step may have at most 20 checks; a wrong one is refused with 400 and names it, such as `steps[0]: checks[1]: pattern is not a valid regular expression`. Checks need a command. A pattern stops after 250 ms and then counts as failed.

For **Send to terminal**, checks are tested when the person presses **Mark done**: the pasted output is the only stream, whatever `stream` says, and an `exitCode` check fails with "no exit code" unless the person entered one. **Mark failed** records the person's verdict without testing.

```json
"checks": [
  { "type": "exitCode", "equals": 0 },
  { "type": "contains", "text": "active (running)", "stream": "stdout", "label": "nginx runs" },
  { "type": "notMatches", "pattern": "^\\s*error", "stream": "stderr" },
  { "type": "value", "name": "version", "matches": "^1\\.2[4-9]\\." }
]
```

Each run has the results in the same order, as `checks: [{ "label", "ok", "detail" }]`, or `null` when nothing was tested:

```json
"checks": [
  { "label": "exit code is 0", "ok": true, "detail": "exit code 0" },
  { "label": "nginx runs", "ok": false, "detail": "expected stdout to contain 'active (running)'" }
]
```

A detail never repeats the output itself, so it is the same for a hidden step. A step that ran cannot change its checks: add a new step with the checks you want.

### Wait timers

When a step must not start right after the one before it (a service restarting, a cache filling, DNS spreading), say so with `waitAfterPreviousSeconds` instead of a line in the body. The timer starts when the step before it, by position, last ended: its latest run finished, or the person marked it done or skipped it. The person sees a countdown ("Wait 1:42 before you start") with `waitReason`, and **Run** or **Send to terminal** before the end asks "Start anyway?" first. Starting early is audited.

While the timer runs, the step in `GET /runbooks/{id}` and `get_runbook` has `waitUntil`, the ISO time it ends; otherwise `waitUntil` is `null`, also before the step before it has ended. The first step never waits.

Restart, then wait 120 s before the health check:

```json
"steps": [
  { "title": "Restart the app", "hostId": 3, "command": "sudo systemctl restart app" },
  { "title": "Health check", "hostId": 3,
    "command": "curl -fsS https://localhost:8443/health",
    "waitAfterPreviousSeconds": 120, "waitReason": "let the service restart",
    "checks": [{ "type": "contains", "text": "ok" }] }
]
```

### Example

```bash
BASE=https://termix.example.com/plugin-api/runbooks/agent
# Keep the token in a secret store or an environment variable.

curl -sS -H "Authorization: Bearer $RUNBOOKS_TOKEN" "$BASE/hosts"

curl -sS -H "Authorization: Bearer $RUNBOOKS_TOKEN" \
  -H "Content-Type: application/json" -X POST "$BASE/runbooks" -d '{
    "title": "Restart nginx on web-1",
    "summary": "The config changed. Check it, then restart.",
    "values": { "svc": "nginx" },
    "steps": [
      { "title": "Check the config", "hostId": 3,
        "command": "sudo nginx -t", "expect": "`syntax is ok`",
        "checks": [{ "type": "contains", "text": "syntax is ok" }] },
      { "title": "Note the version", "hostId": 3, "command": "nginx -v 2>&1",
        "captures": [{ "name": "version", "pattern": "nginx/(\\S+)" }] },
      { "title": "Restart", "hostId": 3,
        "command": "sudo systemctl restart {{svc}}" },
      { "title": "Tell the team",
        "body": "Post that {{svc}} {{version}} restarted." }
    ]
  }'

# Later: read what happened.
curl -sS -H "Authorization: Bearer $RUNBOOKS_TOKEN" "$BASE/runbooks/1"
```

A run in the answer looks like this:

```json
{
  "id": 12,
  "stepId": 40,
  "mode": "exec",
  "status": "done",
  "command": "sudo nginx -t",
  "userId": "…",
  "startedAt": "2026-11-07T10:01:00.000Z",
  "finishedAt": "2026-11-07T10:01:01.000Z",
  "exitCode": 0,
  "stdout": "",
  "stderr": "nginx: configuration file /etc/nginx/nginx.conf test is successful\n",
  "pastedOutput": null,
  "truncated": false,
  "timedOut": false,
  "error": null,
  "running": false,
  "lastOutputAt": null,
  "checks": [
    {
      "label": "the output contains 'syntax is ok'",
      "ok": true,
      "detail": "the output contains 'syntax is ok'"
    }
  ],
  "captured": {}
}
```

`mode` is `exec` (run over SSH) or `terminal` (sent to a terminal; `pastedOutput` holds what the person pasted). `status` is `running`, `awaiting-output`, `done` or `failed`.

While a command runs, its run has `status: "running"` and `running: true`, `stdout` and `stderr` hold the output that has arrived so far, and `lastOutputAt` is when it last printed anything (`null` before the first output). Read the runbook again to follow it; once a second is plenty. Output of a hidden step still reads `[hidden by owner]`. A run the person stopped ends `failed` with `error: "stopped by <user id>"`; a run cut short by a Termix restart ends `failed` with `error: "interrupted: Termix restarted while it ran"` and the output that had been saved. Agents cannot stop a run.

## MCP

`POST /plugin-api/runbooks/agent/mcp` is an MCP server over streamable HTTP: JSON-RPC 2.0, one JSON answer per request, no event stream and no session. It answers `initialize`, `notifications/initialized`, `ping`, `tools/list` and `tools/call`, with the same token.

| Tool             | What it does                                    |
| ---------------- | ----------------------------------------------- |
| `list_hosts`     | Hosts the token can use                         |
| `list_runbooks`  | Runbooks with progress                          |
| `get_runbook`    | One runbook with steps, notes, runs and outputs |
| `create_runbook` | Propose a runbook with steps                    |
| `update_runbook` | Change title, summary, values or status         |
| `add_steps`      | Add steps at the end or at a position           |
| `update_step`    | Change a step that has not run                  |
| `remove_step`    | Remove a step that has not run                  |
| `reorder_steps`  | New step order                                  |
| `get_values`     | Effective values                                |

A tool error (a refused change) comes back as a result with `isError: true` and the reason, so the agent can read it and try something else.

### Client config

Most MCP clients take a URL and headers. For example, a project `.mcp.json` for Claude Code, with the token in the `RUNBOOKS_TOKEN` environment variable:

```json
{
  "mcpServers": {
    "termix-runbooks": {
      "type": "http",
      "url": "https://termix.example.com/plugin-api/runbooks/agent/mcp",
      "headers": { "Authorization": "Bearer ${RUNBOOKS_TOKEN}" }
    }
  }
}
```

Check it with curl:

```bash
curl -sS -H "Authorization: Bearer $RUNBOOKS_TOKEN" \
  -H "Content-Type: application/json" -X POST "$BASE/mcp" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

## Writing runbooks with an AI agent

Connect the agent with the MCP config above, then ask for a runbook instead of asking it to run commands. For example:

> Our web servers need the new TLS certificate. Use the termix-runbooks tools. List the hosts, then create a runbook that checks the current certificate's expiry on each web host, copies the new certificate in place, tests the nginx config, and reloads nginx. Put the certificate path in a value. Capture the new expiry date from `openssl x509 -enddate -noout`. Mark the step that prints the key as hidden from agents. Give each step a short body that says why, and an expect line. Give me the link to the runbook (our Termix address followed by its openPath). Then wait: I will run the steps. When I say so, read the runbook and tell me what failed and what to do next.

Good habits for the prompt:

- Ask for one command per step, with an `expect` line, so each approval is small.
- Ask for checks on each step that has an expected result, so a wrong result marks the step failed instead of passing unnoticed.
- Ask for a wait timer where a step must wait after the one before it, instead of "wait two minutes" in the text.
- Ask for checks before changes, and a check after each change.
- Ask the agent to read `get_runbook` after you run steps, and to add new steps rather than change ones that ran.
- Ask it to put names, paths and versions in values, so you can read them in one place.
- Ask it to hide output that could hold secrets.
