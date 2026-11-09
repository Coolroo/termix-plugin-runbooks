---
title: Agent API and MCP
order: 1
---

# Agent API and MCP

An agent talks to Runbooks with a **Runbooks token**, over plain REST or over MCP. Both do the same things: list hosts, propose runbooks and steps, change steps that have not run, and read runbooks with every run and its output. Neither can run, skip or reopen a step. The only step an agent can end is its own: a step with `owner: "agent"` (see [Agent steps](#agent-steps)).

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

| Method and path                 | What it does                                                                       |
| ------------------------------- | ---------------------------------------------------------------------------------- |
| `GET /hosts`                    | Hosts ticked for the token: `id`, `name`, `address`, `folder`                      |
| `GET /runbooks?status=open`     | Runbooks with progress; `status` is `open`, `done` or `abandoned`                  |
| `POST /runbooks`                | Propose a runbook with steps (201)                                                 |
| `GET /runbooks/{id}`            | One runbook: steps, notes, every run and its output, newest first                  |
| `PATCH /runbooks/{id}`          | Change `title`, `summary`, `values` (the whole set), `status`, `owner` or `notify` |
| `POST /runbooks/{id}/steps`     | Add `steps`, at the end or at a 1-based `position` (201)                           |
| `POST /runbooks/{id}/reorder`   | `{ "stepIds": [...] }` with every step once                                        |
| `GET /runbooks/{id}/values`     | Effective values and where each came from                                          |
| `PATCH /steps/{id}`             | Change a step that has not run; only the given fields change                       |
| `DELETE /steps/{id}`            | Remove a step that has not run                                                     |
| `POST /steps/{id}/complete`     | End an agent step: `{ outcome, note?, output? }`                                   |
| `GET /events?since=0&limit=100` | Events of the token's runbooks, oldest first; see [Events](#events)                |
| `POST /mcp`                     | MCP (below)                                                                        |

### A link for the person

Every runbook in an answer (list, read, create, change) has `openPath`, such as `/?view=runbook&id=12`. It is relative because Runbooks does not know the address people use. The person opens your Termix address followed by `openPath`, for example `https://termix.example.com/?view=runbook&id=12`, and the Runbooks tab opens on that runbook. A person who is signed out signs in first and then lands on it. When Termix runs under a base path, put the base path before `openPath`. Have the agent give the person that link for each runbook it makes.

Every change answers with the whole runbook, as `GET /runbooks/{id}` does. Errors are `{ "error": "..." }` with status 400 (bad input), 401 (token), 403, 404, 409 (the step already ran, or the runbook is not open) or 429 (rate limit).

### A step

| Field                      | Type            | What it is                                                                                         |
| -------------------------- | --------------- | -------------------------------------------------------------------------------------------------- |
| `title`                    | string          | Required. Up to 200 characters.                                                                    |
| `owner`                    | string          | `"person"` (the default) or `"agent"`. See [Agent steps](#agent-steps).                            |
| `body`                     | markdown        | What to do and why, shown before the command.                                                      |
| `hostId`                   | integer or null | A host from `/hosts`. Leave it out for a manual step (text only).                                  |
| `command`                  | string or null  | The shell command. Needs `hostId`.                                                                 |
| `expect`                   | markdown        | What the person should see when it works.                                                          |
| `captures`                 | array           | `[{ "name": "version", "pattern": "nginx/(\\S+)" }]`: values to take from standard output.         |
| `checks`                   | array           | Rules tested on the output when the run ends; see [Checks](#checks). At most 20.                   |
| `hideOutputFromAgents`     | boolean         | Hide the output from agents. An agent can set it but not clear it.                                 |
| `timeoutMs`                | integer or null | Time limit, 1000 to 600000. Default 120000.                                                        |
| `waitAfterPreviousSeconds` | integer or null | Seconds to wait after the previous step ended, 1 to 86400. See [Wait timers](#wait-timers).        |
| `waitReason`               | string or null  | Why to wait, up to 500 characters. Needs `waitAfterPreviousSeconds`.                               |
| `stdin`                    | object or null  | Where a Run takes the command's standard input from. See [Standard input](#standard-input).        |
| `secretCaptures`           | array           | `[{ "name": "api_token", "pattern": "token: (\\S+)" }]`: secrets to keep. See [Secrets](#secrets). |

A step that has run is history: changing it, removing it, or putting a step before it is refused with 409. Add a new step instead.

### Who a runbook belongs to

Set `owner` on a runbook when you create it (`POST /runbooks`, `create_runbook`) or later (`PATCH`, `update_runbook`):

| Field   | Up to          | What it is                                                                                   |
| ------- | -------------- | -------------------------------------------------------------------------------------------- |
| `task`  | 64 characters  | The task the runbook is for, such as `T-176` or `ops/T-7`                                    |
| `agent` | 200 characters | An address of your session that a notification receiver understands; Runbooks never reads it |
| `label` | 80 characters  | Your name as the person sees it                                                              |

All three are optional; `null` clears the owner. The person sees "Agent: <label> · task <task>" under the runbook's title, with the token's name when there is no label. Notifications carry the owner, so a receiver knows which session to wake (see [Notifications](notifications.md)).

### Agent steps

Some steps are work for the agent between the person's steps: read a dashboard, change a file in a repository, wait for a pipeline. Give such a step `"owner": "agent"`.

- The person sees **Waiting for the agent** with your label instead of Run, Send to terminal or Done. They can only **Skip** it (with a reason) or **Reopen** it. Termix never runs it: Run and Send to terminal are refused with 409 `agent-step`.
- Its `command` is optional and only says what you will run. It needs no `hostId`; when it has one, the host must be one of the token's.
- It cannot have `captures`, `secretCaptures`, `stdin` or a wait timer (400). Its checks test the output you hand in, so `exitCode` checks are refused and `contains` or `matches` read that one output, whatever `stream` says.

When it is your turn, that is when every earlier step ended (done, failed or skipped), end the step:

```bash
curl -sS -H "Authorization: Bearer $RUNBOOKS_TOKEN" -H "Content-Type: application/json" \
  -X POST "$BASE/steps/41/complete" \
  -d '{ "outcome": "done", "note": "The error rate is back under 0.1 %.", "output": "error_rate 0.0004\n" }'
```

| Field     | What it is                                                |
| --------- | --------------------------------------------------------- |
| `outcome` | Required: `done` or `failed`                              |
| `note`    | What you did, up to 2000 characters. The person reads it. |
| `output`  | What you got, up to 64 KB. The step's checks test it.     |

It records a run with `mode: "agent"`, your token's name as `userId`, the note and the output (as `stdout`). With `outcome: "done"` a failed check makes the step failed. It is refused with 403 `person-step` for a person's step, 409 `order` while an earlier step is still pending, 409 `ended` for a step that already ended (only a person can reopen it) and 409 `closed` when the runbook is not open. A later step can read your output as its standard input with `{ "from": "step", "step": N, "stream": "stdout" }`.

### Events

Runbooks records what happens to a runbook that its agent may want to hear about:

| Type           | When                                                                                                   | `reason`                                                        |
| -------------- | ------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------- |
| `agent-turn`   | An agent step became the next step: a step ended, was skipped or reopened, or the runbook was reopened |                                                                 |
| `step-failed`  | A step ended failed, also when a check failed                                                          | `exit`, `check`, `stopped`, `interrupted`, `secret` or `manual` |
| `runbook-done` | The runbook was marked done or abandoned                                                               | `done` or `abandoned`                                           |
| `sent`         | The person pressed **Send to agent** on a step, maybe with a note                                      |                                                                 |
| `step-done`    | A step ended done. Recorded only when the runbook's `notify` lists it                                  |                                                                 |

`reason` for `step-failed`: `exit` (the command exited non-zero, timed out or could not connect), `check` (a check failed), `stopped` (a person pressed Stop), `interrupted` (Termix or Runbooks restarted while it ran), `secret` (a secret capture found nothing or could not be stored) and `manual` (a person marked it failed, or the agent ended its step with `outcome: "failed"`).

Creating or changing a runbook or its steps is not an event, and neither is a note, hiding output, or starting a run. `agent-turn` is recorded once per change that makes an agent step next, not when you create a runbook whose first step is yours.

`GET /runbooks/{id}` lists the runbook's latest 100 events, newest first, as `events`:

```json
"events": [
  { "id": 91, "type": "sent", "reason": null, "stepId": 41, "stepPosition": 3,
    "note": "The graph looks odd after 10:05, check it", "createdBy": "alice",
    "createdAt": "2026-11-09T10:07:00.000Z", "deliveredAt": "2026-11-09T10:07:01.000Z" }
]
```

`GET /events?since=<id>&limit=<n>` (MCP `list_events`) lists the events of every runbook the token sees, oldest first, after the event id `since` (default 0), at most `limit` (default 100, up to 500). Each event also has `runbookId` and `openPath`. The answer is `{ "events": [...], "next": 91 }`: call again with `since` set to `next`. Use it to poll, or to catch up after a missed notification.

#### notify

`notify` on a runbook lists the event types that the [notification webhook](notifications.md) delivers for it. The default is `["agent-turn", "step-failed", "runbook-done", "sent"]`; add `"step-done"` to hear about every step. `sent` is always delivered. Set it on create or with `PATCH`; `null` puts the default back. `GET /runbooks/{id}` shows the list in force.

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

### Standard input

A command that reads its standard input gets it from one source, set as `stdin` on the step. **Run** writes it to the command and then ends the input. **Send to terminal** is refused for such a step (409 `stdin-run-only`), because nothing can be typed into a command's standard input there.

| `stdin`                                                       | The input                                                                                                                           |
| ------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `{ "from": "step", "step": 2, "stream": "stdout" }`           | The standard output (or `stderr`) of the latest finished run of an earlier step, by position; for a terminal run, its pasted output |
| `{ "from": "value", "name": "build_id" }`                     | The value, with one newline after it                                                                                                |
| `{ "from": "secret", "name": "api_token" }`                   | A secret an earlier step of this runbook captured; see [Secrets](#secrets)                                                          |
| `{ "from": "secret", "library": "shared/registry/password" }` | A secret from the OpenBao Secrets library: `mine/<name>` (the person's own) or `shared/<name>`, read as the person who runs it      |

- `step` must be before the step. Runbooks keeps the step it names when steps move or are inserted; a step whose output another step reads cannot be removed, or moved after the reader.
- The run is refused with 409 `stdin-missing` while that step has no finished run, or its last run failed. Add `"allowFailed": true` to the source to take the output of a failed run too. A step with no command has no output to give.
- At most 256 KB.
- The hash the person approves covers the source (not the input itself), so changing the source makes an open page stale.
- Agents see the source, and on each run `stdin: { ...source, "bytes": 1229 }`, never the input.

Read a config, then check it:

```json
"steps": [
  { "title": "Read the config", "hostId": 3, "command": "cat /etc/app/config.json" },
  { "title": "Check the version", "hostId": 3, "command": "jq -e '.version == \"2\"'",
    "stdin": { "from": "step", "step": 1, "stream": "stdout" } }
]
```

### Secrets

A step can keep a secret its command prints, such as a new token, and a later step can read it as standard input. Nobody copies it, and **secrets never appear in commands**: there is no `{{secret}}` placeholder. A command reads a secret from its standard input (`--password-stdin`, `--token-stdin`, `read -r TOKEN`).

`secretCaptures` works like `captures`: a JavaScript regular expression, in multiline mode, with exactly one capturing group, run on the standard output (or the pasted terminal output), with the same time limit. At most 10 per step, names like value names, up to 64 characters. When the run (or a terminal **Mark done**) ends done:

- each match is stored through the OpenBao Secrets plugin, in Runbooks' own area, for 7 days
- a pattern that matches nothing, or an empty match, fails the step with `secret api_token: no match`, so a later step never gets an empty secret
- the value is replaced by `[secret:api_token]` in the step's standard output, standard error, pasted output and captured values before anything is stored, and so is every secret a step reads. The output of a step that captures a secret is held until its run ends: a running run has `outputHeld: true` and no output yet.

A step that reads a secret by `name` needs an earlier step that captures it (400 otherwise). When the runbook is done or abandoned, its secrets are deleted.

Step 2 creates a token; step 3 logs in with `--password-stdin` reading the secret:

```json
"steps": [
  { "title": "Check the registry", "hostId": 3, "command": "curl -fsS https://registry.example.com/v2/" },
  { "title": "Create a CI token", "hostId": 3, "command": "registry-admin token create --name ci",
    "secretCaptures": [{ "name": "api_token", "pattern": "^token: (\\S+)$" }] },
  { "title": "Log in", "hostId": 4,
    "command": "docker login -u ci --password-stdin registry.example.com",
    "stdin": { "from": "secret", "name": "api_token" } }
]
```

You never get a value. A runbook in an answer lists its secrets by name:

```json
"secrets": [
  { "name": "api_token", "step": 2, "set": true, "expiresAt": "2026-11-16T10:01:01.000Z" }
]
```

`set` is false before the step captured it, after it was deleted, and once it expired. Each run says which secrets it read and stored, by name: `"secrets": { "used": ["api_token"], "captured": [] }`.

Secrets need the OpenBao Secrets plugin, connected to OpenBao, and the person who runs the step needs its **Use secrets** permission. Without the plugin, a step that captures or reads a secret is refused with 409 `no-secrets`, "Install and connect the OpenBao Secrets plugin to use secrets". A secret that is not there is refused with 409 `secret-missing`.

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
  "stdin": null,
  "secrets": null,
  "note": null,
  "startedEarlySeconds": null,
  "captured": {}
}
```

`mode` is `exec` (run over SSH), `terminal` (sent to a terminal; `pastedOutput` holds what the person pasted), `manual` (a step with no command that the person marked **Done** or **Failed**; `hostId` is `null`, `command` is empty and `note` holds the person's note) or `agent` (an agent step the agent ended; `userId` is the token's name, `hostId` is `null`, `note` and `stdout` are what the agent handed in). `status` is `running`, `awaiting-output`, `done` or `failed`. `stdin` is the source and size of the standard input the run got, `secrets` the secrets it read and stored, by name, and `startedEarlySeconds` how much of the step's wait timer was left when the person started it anyway (`null` when it was not early).

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
| `complete_step`  | End an agent step when it is the agent's turn   |
| `list_events`    | Events of the token's runbooks after an id      |

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
- Ask it to pass secrets and earlier output with `stdin` and `secretCaptures`, never by putting them in a command, so you do not copy them from step to step.
- Ask it to set `owner` with its task, and to make its own work agent steps (`"owner": "agent"`) instead of steps that say "tell the agent". With notifications on, the agent hears when it is its turn; without them it can poll `list_events`.
