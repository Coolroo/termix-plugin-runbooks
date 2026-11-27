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

| Method and path                                             | What it does                                                                                 |
| ----------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `GET /hosts`                                                | Hosts ticked for the token: `id`, `name`, `address`, `folder`                                |
| `GET /vms?host=4`                                           | Read only: the token's VM hosts in HAW, or the VMs on one; see [VM steps](#vm-steps)         |
| `GET /runbooks?status=open&folder=termix`                   | Runbooks with progress; `status` is `open`, `done` or `abandoned`; see [Folders](#folders)   |
| `POST /runbooks`                                            | Propose a runbook with steps (201)                                                           |
| `GET /runbooks/{id}`                                        | One runbook: steps, notes, every run and its output, newest first                            |
| `PATCH /runbooks/{id}`                                      | Change `title`, `summary`, `values` (the whole set), `status`, `owner`, `notify` or `folder` |
| `POST /runbooks/{id}/steps`                                 | Add `steps`, at the end or at a 1-based `position` (201)                                     |
| `POST /runbooks/{id}/reorder`                               | `{ "stepIds": [...] }` with every step once, without amendments                              |
| `GET /runbooks/{id}/values`                                 | Effective values and where each came from                                                    |
| `GET /runbooks/{id}/runs/{runId}/items/{item}/attempts/{n}` | One attempt of an item, with its output; see [Waits and retries](#waits-and-retries)         |
| `PATCH /steps/{id}`                                         | Change a step that has not run; only the given fields change                                 |
| `DELETE /steps/{id}`                                        | Remove a step that has not run                                                               |
| `POST /steps/{id}/complete`                                 | End an agent step: `{ outcome, note?, output? }`                                             |
| `POST /steps/{id}/amend`                                    | Amend a step in place: `{ kind, reason, step }`; see [Amendments](#amendments)               |
| `GET /events?since=0&limit=100`                             | Events of the token's runbooks, oldest first; see [Events](#events)                          |
| `POST /mcp`                                                 | MCP (below)                                                                                  |

### A link for the person

Every runbook in an answer (list, read, create, change) has `openPath`, such as `/?view=runbook&id=12`. It is relative because Runbooks does not know the address people use. The person opens your Termix address followed by `openPath`, for example `https://termix.example.com/?view=runbook&id=12`, and the Runbooks tab opens on that runbook. A person who is signed out signs in first and then lands on it. When Termix runs under a base path, put the base path before `openPath`. Have the agent give the person that link for each runbook it makes.

Every change answers with the whole runbook, as `GET /runbooks/{id}` does. Errors are `{ "error": "..." }` with status 400 (bad input), 401 (token), 403, 404, 409 (the step already ran, or the runbook is not open) or 429 (rate limit).

### A step

| Field                      | Type            | What it is                                                                                                          |
| -------------------------- | --------------- | ------------------------------------------------------------------------------------------------------------------- |
| `title`                    | string          | Required. Up to 200 characters.                                                                                     |
| `owner`                    | string          | `"person"` (the default) or `"agent"`. See [Agent steps](#agent-steps).                                             |
| `body`                     | markdown        | What to do and why, shown before the command. May use `{{name}}` (1.4.3).                                           |
| `hostId`                   | integer or null | A host from `/hosts`. Leave it out for a manual step (text only) or a step with `where`.                            |
| `command`                  | string or null  | The shell command. Needs `hostId`, or `where` for a command run outside Termix.                                     |
| `where`                    | string or null  | Where the person runs `command` outside Termix, up to 80 characters. See [Outside Termix](#outside-termix).         |
| `expect`                   | markdown        | What the person should see when it works. May use `{{name}}` (1.4.3).                                               |
| `captures`                 | array           | `[{ "name": "version", "pattern": "nginx/(\\S+)" }]`: values to take from standard output.                          |
| `checks`                   | array           | Rules tested on the output when the run ends; see [Checks](#checks). At most 20.                                    |
| `hideOutputFromAgents`     | boolean         | Hide the output from agents. An agent can set it but not clear it.                                                  |
| `timeoutMs`                | integer or null | Time limit, 1000 to 600000. Default 120000.                                                                         |
| `waitAfterPreviousSeconds` | integer or null | Seconds to wait after the previous step ended, 1 to 86400. See [Wait timers](#wait-timers).                         |
| `waitReason`               | string or null  | Why to wait, up to 500 characters. Needs `waitAfterPreviousSeconds`.                                                |
| `stdin`                    | object or null  | Where a Run takes the command's standard input from. See [Standard input](#standard-input).                         |
| `secretCaptures`           | array           | `[{ "name": "api_token", "pattern": "token: (\\S+)" }]`: secrets to keep. See [Secrets](#secrets).                  |
| `generate`                 | object or null  | A Make a secret step (1.4.2). See [Make a secret and Ask for a secret](#make-a-secret-and-ask-for-a-secret).        |
| `ask`                      | object or null  | An Ask for a secret step (1.4.2). See the same section.                                                             |
| `runIn`                    | string          | `"either"` (the default), `"terminal"` or `"run"` (1.4.6). See [Run or Send to terminal](#run-or-send-to-terminal). |
| `runInReason`              | string or null  | Why, one line, up to 200 characters, shown to the person. Needs `runIn` `"terminal"` or `"run"`.                    |
| `when`                     | object or null  | When the step is needed, as a rule on earlier steps (1.4.6). See [Conditional steps](#conditional-steps).           |
| `decision`                 | object or null  | A Decision step: options the person chooses from (1.4.6). See [Decision steps](#decision-steps).                    |
| `interactive`              | boolean         | Run opens a terminal (pty), for sudo, ssh and other prompts (1.4.6). See [Typed input](#typed-input).               |
| `sequence`                 | array or null   | Items one Run runs in order, instead of `command` (1.4.10). See [Sequences](#sequences).                            |
| `workdir`                  | string or null  | An absolute folder the command, or each run item, starts in (1.4.10). See [Sequences](#sequences).                  |

A step that has run is history: changing it, removing it, or putting a step before it is refused with 409. Amend it instead (see [Amendments](#amendments)).

### Amendments

To fix a step, or to add a step between two steps, amend it in place. Do not add the fix at the end, and do not insert steps that renumber the rest.

```bash
curl -sS -H "Authorization: Bearer $RUNBOOKS_TOKEN" -H "Content-Type: application/json" \
  -X POST "$BASE/steps/42/amend" \
  -d '{ "kind": "replace", "reason": "The unit is app.service, not app.",
        "step": { "title": "Restart the app", "hostId": 3, "command": "systemctl restart app.service" } }'
```

| Field    | What it is                                                                                     |
| -------- | ---------------------------------------------------------------------------------------------- |
| `kind`   | `replace`: a fixed version of the step. `substep`: an extra step after it.                     |
| `reason` | Required, one line, up to 500 characters. The person sees "Amended by <token name>: <reason>". |
| `step`   | The new step, with the same fields and checks as a new step (see [A step](#a-step)).           |

- The new step keeps the step's number and gets the next letter: the first amendment of step 3 is **3a**, the next **3b**, in the order they were made. No other step moves or gets a new number. Steps are in the order (number, letter).
- `replace` is for a step that did not end done: pending, failed or skipped. The old step's `status` becomes `replaced`. It keeps its runs, the person sees it folded as "Replaced by 3a" and can open it, and it counts as ended: it does not block a later step, and it cannot run, be marked or be skipped. The new step shows the old command struck through above the new one. A replaced step whose output the person hid gives a fixed version with hidden output too.
- `substep` works on a step in any state, also a done step.
- An amendment can be amended: replace 3a, and the fixed version is 3b.
- A later step names an amendment in `stdin` by its label as text: `{ "from": "step", "step": "3a", "stream": "stdout" }`. Numbers (`3` or `"3"`) still name step 3.
- Every guard of a new step applies: the hosts of the token, the shape rules, secret reads, and the limit of 200 steps. The person runs it with the same Run confirm, repeat guard and host check.
- Refused: 404 for a step the token does not see, 409 `closed` when the runbook is not open, 409 `running` while a run of the step is running or waits for pasted output, 409 `done` for `replace` on a step that ended done (use `substep`), and 409 `replaced` for `replace` on a step that was already replaced (amend its replacement; `replacedBy` says which).
- It answers with the whole runbook. Each step has `label` (`"3"` or `"3a"`), `suffix`, `amendment` (`{ kind, reason, by, stepId, stepLabel, oldCommand }` or `null`) and `replacedBy` (`{ id, label }` on a replaced step, otherwise `null`).
- It records an `amended` event (see [Events](#events)).

With amendments, `POST /runbooks/{id}/steps` with `position` and `reorder` count steps, not amendments: an amendment moves with its step. `DELETE /steps/{id}` removes a sub-step that has not run (the letters after it stay); a step that has amendments, and a fixed version (`replace`), stay.

The person can still **Skip** a fixed version. **Reopen** on a replaced step works only when its fixed version was skipped and never ran; the step is then pending again. Otherwise Reopen is refused with 409 `replaced`.

### Outside Termix

Some commands do not run in a shell on a Termix host: PowerShell on a Windows PC, a browser console, another app. Give such a step `command` and `where`, and no `hostId`, instead of a code block in `body`:

```json
{
  "title": "Check the Windows build",
  "where": "Windows PC, PowerShell as admin",
  "command": "Get-ComputerInfo -Property OsBuildNumber",
  "checks": [{ "type": "matches", "pattern": "OsBuildNumber\\s*:\\s*26100" }]
}
```

- The person sees "Run outside Termix: <where>", the command with its values filled in, and a **Copy** button (off while a value is missing). There is no Run and no Send to terminal (409 `outside`): Termix never runs it.
- The person pastes the output and marks the step **Done** or **Failed**. Checks (not `exitCode`) and `captures` read the pasted output; a failed check makes the step failed. On a step with checks, **Done** needs at least one line of pasted output (1.4.1; refused with 400 otherwise); **Failed** needs none. It records a run with `mode: "outside"`, the command as the person copied it, and the output as `pastedOutput`.
- Refused with 400: `where` without `command`, `where` with `hostId`, `stdin`, `secretCaptures`, `exitCode` checks, and `where` on an agent step. A command with no `hostId` and no `where` is refused too.
- The repeat guard and the command hash do not apply. Done and Failed are bound to the step's revision: a step that changed since the person saw it is refused with 409 `stale`.

Every fenced code block in a step's `body` and `expect` also gets a Copy button; inline code does not.

### Who a runbook belongs to

Set `owner` on a runbook when you create it (`POST /runbooks`, `create_runbook`) or later (`PATCH`, `update_runbook`):

| Field   | Up to          | What it is                                                                                   |
| ------- | -------------- | -------------------------------------------------------------------------------------------- |
| `task`  | 64 characters  | The task the runbook is for, such as `T-42` or `ops/T-7`                                     |
| `agent` | 200 characters | An address of your session that a notification receiver understands; Runbooks never reads it |
| `label` | 80 characters  | Your name as the person sees it                                                              |

All three are optional; `null` clears the owner. The person sees "Agent: <label> · task <task>" under the runbook's title, with the token's name when there is no label. Notifications carry the owner, so a receiver knows which session to wake (see [Notifications](notifications.md)).

### Folders

The person's Runbooks list (1.4.10) has a section per state (Open, Done, Abandoned) and, inside each, a collapsible group per folder, with the runbooks in no folder last. Set `folder` on a runbook when you create it (`POST /runbooks`, `create_runbook`) or later (`PATCH`, `update_runbook`). Use your task's board or project name, such as `home-server`, `gbtvg-coop` or `termix`, so one project's runbooks sit together.

- **One level.** A folder holds runbooks, never folders: a name is trimmed, 1 to 60 characters, with no `/` and no control characters. Anything else is refused with 400 and nothing changes.
- **One spelling.** A name that is one of your runbooks' folders in other letters gets that folder's spelling: `Home-Server` joins `home-server`. The answer's `folder` is what was stored.
- **No folder.** `null` (or leaving `folder` out on create) puts the runbook in no folder. A folder exists only while a runbook is in it; there is nothing to make or remove.
- **Any status, nothing else.** A `PATCH` with only `folder` works on an open, done or abandoned runbook and changes only its folder: not its status, `revision` or `updatedAt`, and it makes no event. With other fields too, those change as they always do. Each move is in Termix's audit log (`runbooks_runbook_folder`), with the token's name.
- **Reading.** Every runbook in a list or a read has `folder` (`null`: no folder). `GET /runbooks?folder=termix` (MCP: `list_runbooks` with `folder`) lists one folder, any spelling of it; on MCP, `folder: null` lists the runbooks in no folder.
- **People move them too.** The person can move a runbook to another folder or rename a folder (every runbook in it moves). Read `folder` again before you rely on it.

To file runbooks that exist already, list them and send one `PATCH` per runbook with only `folder`:

```bash
curl -s -X PATCH -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"folder": "home-server"}' "$BASE/runbooks/42"
```

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
| `amended`      | An agent amended a step; `stepId` is the new step. Not delivered unless `notify` lists it              | `replace` or `substep`                                          |

`reason` for `step-failed`: `exit` (the command exited non-zero, timed out or could not connect), `check` (a check failed), `stopped` (a person pressed Stop), `interrupted` (Termix or Runbooks restarted while it ran), `secret` (a secret capture found nothing or could not be stored) and `manual` (a person marked it failed, or the agent ended its step with `outcome: "failed"`).

Creating or changing a runbook or its steps is not an event, and neither is a note, hiding output, or starting a run. `agent-turn` is recorded once per change that makes an agent step next, not when you create a runbook whose first step is yours. A step its `when` rule says is not needed (1.4.6) counts as ended: an agent step after it can be next, and an agent step that is not needed never is.

`GET /runbooks/{id}` lists the runbook's latest 100 events, newest first, as `events`:

```json
"events": [
  { "id": 91, "type": "sent", "reason": null, "stepId": 41, "stepPosition": 3, "stepLabel": "3",
    "note": "The graph looks odd after 10:05, check it", "createdBy": "alice",
    "createdAt": "2026-11-09T10:07:00.000Z", "deliveredAt": "2026-11-09T10:07:01.000Z" }
]
```

`stepLabel` is `"3a"` for an amendment, with `stepPosition` 3. `GET /events?since=<id>&limit=<n>` (MCP `list_events`) lists the events of every runbook the token sees, oldest first, after the event id `since` (default 0), at most `limit` (default 100, up to 500). Each event also has `runbookId` and `openPath`. The answer is `{ "events": [...], "next": 91 }`: call again with `since` set to `next`. Use it to poll, or to catch up after a missed notification.

#### notify

`notify` on a runbook lists the event types that the [notification webhook](notifications.md) delivers for it. The default is `["agent-turn", "step-failed", "runbook-done", "sent"]`; add `"step-done"` to hear about every step, and `"amended"` to hear about amendments. `sent` is always delivered. Set it on create or with `PATCH`; `null` puts the default back. `GET /runbooks/{id}` shows the list in force.

### Values and placeholders

`{{name}}` in a command is replaced by the value of `name`, as plain text, with no shell quoting. Values come from the runbook's `values` object first, then from captures of earlier steps in step order; a later value wins. Names match `[A-Za-z_][A-Za-z0-9_.-]*`. A step whose placeholders, in its command or its checks (see "Checks"), have no value cannot run, and its `missing` field names them.

**A captured value goes into a command only through a pattern** (1.4.10). A value a step or a sequence item captures comes from a host's output, so it may go into a command Termix runs (a step's `command`; a run, wait or job item's `command`; an event's `name`, `unit`, `container`, `path`, `url`, `contains` or `servername`) only when the step or item that captures it checks it with a `value` check that has `matches`:

```json
{
  "title": "Read the version",
  "hostId": 1,
  "command": "app --version",
  "captures": [{ "name": "ver", "pattern": "version: (\\S+)" }],
  "checks": [{ "type": "value", "name": "ver", "matches": "^[0-9.]+$" }]
}
```

Without it, create, add steps, update step and amend (REST and MCP) answer 400 with `code` `captured-value`, naming the step or item that uses the value and the one that captures it. Write a pattern that fits only the form you expect (anchored with `^` and `$`): a value that does not match it fails the capturing step or item, so it never reaches a later command, and a later item of the same run takes the value only when it matches the pattern as a whole. Your runbook's own `values` (shown to the person on the card) and a VM step's values (a fixed form) need no pattern; nor does text Termix does not run (an agent step's, or a step run outside Termix).

Since 1.4.3, `{{name}}` works in `body`, `expect` and `where` too, with the same values. A click step can say "Open the admin console and find `{{ts_ip}}`". `GET /runbooks/{id}` (MCP `get_runbook`) returns each step's text as written and as the person sees it:

| Field            | What it is                                                                              |
| ---------------- | --------------------------------------------------------------------------------------- |
| `resolvedBody`   | `body` with its values. Always present.                                                 |
| `resolvedExpect` | `expect` with its values. Always present.                                               |
| `resolvedWhere`  | `where` with its values; null when the step has no `where`.                             |
| `textMissing`    | Names that `body`, `expect` and `where` use and that have no value yet; `[]` when none. |

- A value that is not set yet stays as `{{name}}` in these fields, as in a command. The person sees "(value ts_ip: not set yet)" there, and the step's "Values missing" line names it.
- A missing value in the text never stops a step. A click step can still be marked done or failed. Only `missing`, the values of the command and its checks, stops a Run.
- `body` and `expect` are Markdown, and a value can be command output, so a value shows as text: outside code, its Markdown characters are escaped with a backslash, its line breaks become spaces, and a bare address in it (`://`, `www.`, `@`) gets an empty HTML comment `<!---->`, which the page drops, so it cannot add a link, an image, a heading, emphasis or HTML. Inside a code span or a code block, the value goes in as it is. A value with backticks gets a longer code span, and a value with a fence line gets a longer fence. A Copy button on a code block copies the filled-in text.
- To make a link from a value, write the link: `[admin console]({{url}})`, `https://{{ip}}:8443/` or `<https://{{host}}/>`. In a link destination the value is escaped and its spaces are percent-encoded; in an autolink its spaces, `<` and `>` are.
- `where` is plain text: values go in as they are.
- A value from a step with `hideOutputFromAgents` shows as `[hidden by owner]` in an agent's view, as in `effectiveValues`. Once such a step ends done, each of its captures shows that way, whether it matched or not.
- A step whose `stdin` is a hidden step's output, or a value a hidden step captures, is hidden too: its output and captures read `[hidden by owner]`, though its own `hideOutputFromAgents` is `false`. So is a person's step whose command, checks or `stdin` reads a hidden VM step's `state` value: the state is one of a few words, so it is never masked in other text, and the step that could print it is hidden instead.
- A run's `command` and its check results' `label` and `detail` are filled from the step with the values you saw when it ran, so a hidden value reads `[hidden by owner]` there and your own text stays as you wrote it.
- Secrets are never values. A secret step, `secretCaptures` and `stdin` from a secret never fill a `{{name}}`, and captured values have secrets removed before they are kept. Use `{{name}}` only for values that may show on the page.

A capture is a JavaScript regular expression, in multiline mode, with exactly one capturing group. It runs on the first 256 KB of standard output (or the pasted terminal output); the first match's group becomes the value.

### Checks

`expect` tells the person what to look for. A check makes Runbooks look for it: each check is tested on the run's full output when the run ends, and if any check fails the step is marked failed, even when the command exited 0. The person sees which check failed and why, and decides what to do next. A step without checks works as before: exit code 0 is done.

| Type                      | Fields                                                         | Passes when                                                                                 |
| ------------------------- | -------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `exitCode`                | `equals` (integer)                                             | the exit code is `equals`                                                                   |
| `contains`, `notContains` | `text`, `stream`                                               | the stream has (or does not have) `text`                                                    |
| `matches`, `notMatches`   | `pattern` (JavaScript regular expression, multiline), `stream` | the stream matches (or does not match) `pattern`                                            |
| `value`                   | `name` (a capture of this step), `equals` or `matches`         | the captured value equals `equals` or matches `matches`; with neither, that it was captured |

Checks take `{{name}}` values, the same values as the command (1.4.6). `text` in `contains` and `notContains` and `equals` in a `value` check get the value as it is. A pattern (`matches`, `notMatches` and `matches` in a `value` check) gets it as literal text, escaped, so a value `1.2.3` matches only `1.2.3` and `^v{{ver}}$` still works. A step whose checks name a value that is not set cannot run, as with its command: `missing` names it, and Run, Send to terminal, Mark done, Done on a step run outside Termix and `complete_step` with `done` answer 409 `missing-values`. The run's check results show the filled-in text. An agent step's checks get the values you see, and a check there that uses a value a hidden step captures is refused (400).

```json
{
  "type": "contains",
  "text": "registry:5443/app:{{ver}}@sha256:",
  "label": "the new image runs"
}
```

`stream` is `stdout`, `stderr` or `any` (the default: either one). Every check may have a `label`, which the person sees instead of a generated description. A step may have at most 20 checks; a wrong one is refused with 400 and names it, such as `steps[0]: checks[1]: pattern is not a valid regular expression`. Checks need a command. A pattern stops after 250 ms and then counts as failed.

Checks see the output with its secrets hidden (1.4.1), the same text the person sees: every secret the step captures or reads reads `[secret:<name>]`, in the output and in captured values. So test for `token: [secret:api_token]`, not for the token. A check that names part of a secret's real value never matches it, whatever the value is, so a check cannot tell you anything about a secret.

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

### Sequences

A step that Termix runs on a host may be a **sequence** of items instead of one command (1.4.10). One **Run** runs the items in order, as the person who pressed it, and the step card shows each item with its label, its type, the exact command (or the wait), its state (waiting, running, passed, failed, skipped) and the time it took. Use it instead of chaining commands with `&&` or `;`, and instead of `sleep` (see [No sleep in commands](#no-sleep-in-commands)).

```json
{
  "title": "Deploy enforcarr",
  "hostId": 3,
  "workdir": "/mnt/sdd/services/media-server",
  "sequence": [
    {
      "type": "run",
      "label": "Deploy",
      "command": "sudo paseo-deploy up media enforcarr"
    },
    { "type": "delay", "seconds": 10, "reason": "let the old container stop" },
    {
      "type": "wait",
      "label": "Healthy",
      "command": "docker inspect -f {{.State.Health.Status}} enforcarr",
      "checks": [{ "type": "contains", "text": "healthy" }],
      "stopIf": [{ "type": "contains", "text": "unhealthy" }],
      "within": 180,
      "every": 5
    },
    {
      "type": "run",
      "label": "Report",
      "command": "docker ps --filter name=enforcarr",
      "onFail": "continue"
    }
  ]
}
```

| Item    | Fields                                                                                                                                                                                                                              |
| ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `run`   | `command` (required), `label`, `checks`, `captures`, `timeoutMs` (1000 to 600000), `onFail` (`"stop"`, the default, or `"continue"`) and `interactive`, each as for a one-command step.                                             |
| `delay` | `seconds` (1 to 3600), `label` and `reason`. A timer in Termix: nothing runs on the host. The person sees a countdown and may **Skip** it.                                                                                          |
| `wait`  | `command`, `checks` (at least one) and `within` (required), `stopIf`, `attempts`, the schedule, `label`, `captures`, `timeoutMs` and `onFail`. Runs the command until its checks pass. See [Waits and retries](#waits-and-retries). |

A `run` item may also have `retry`, for a flaky command: see [Waits and retries](#waits-and-retries).

- A sequence has 1 to 20 items and at least one item that is not a `delay`. The [wait events](#wait-events) (`container`, `unit`, `log`, `http`, `port`, `file`, `job`) are items too.
- Each run item is a new shell on a connection of its own: `cd` and variables do not carry over. Set `workdir` on the step (an absolute path) and every run item runs as `cd -- '<workdir>' && <command>`; leave the `cd` out of the commands. `workdir` also works on a one-command step, whose command then shows and runs with the `cd` in front. It is for a POSIX shell (Linux, macOS); on a Windows host keep the `cd` in the command.
- An item's `captures` fill `{{name}}` in the items after it, and in later steps once the step is done. Capture names are unique in a sequence. Before the run, the person sees such a name as written, with a line that it is filled from an earlier item. A command or an event's text may use such a value only when the item that captures it checks it with a `value` check that has `matches` (see [Values and placeholders](#values-and-placeholders)); at run time the value must match that pattern as a whole, or the item that uses it fails before it runs.
- An item fails when its command exits non-zero, times out, or a check fails. A failed item stops the sequence and fails the step, unless it has `"onFail": "continue"` (for a read-only report after the main work): then the failure is recorded and the next item runs. A step whose only failures were such items ends done.
- **Stop** ends the item that runs, and the rest do not run. After a stop, a failure, or a Termix restart in the middle, the person can **Continue from item N**: a new run that carries the items that passed (they do not run again) and starts at the first item that did not. **Run** again starts from item 1, with the usual repeat question. Continue is refused with 409 `changed` when the sequence or its values changed since that run.
- Before each item after the first, Runbooks checks that the person may still connect to the host; if not, the item fails and the sequence stops.
- Not on a sequence step: `command`, `checks`, `captures`, `timeoutMs`, `interactive` (put them on the run items), `stdin`, `secretCaptures`, `where`, `owner: "agent"`, and `runIn: "terminal"` (a terminal runs one command; Send to terminal is refused for a sequence).
- To make a one-command step a sequence with `update_step`, send `sequence` and `"command": null`.

Each run of a sequence step has `items`, one record per item, in order:

```json
{
  "position": 3,
  "type": "run",
  "label": "Health",
  "command": "docker inspect -f ...",
  "status": "failed",
  "startedAt": "...",
  "finishedAt": "...",
  "plannedEndAt": null,
  "exitCode": 0,
  "stdout": "starting\n",
  "stderr": "",
  "checks": [
    { "label": "the output contains 'healthy'", "ok": false, "detail": "..." }
  ],
  "captured": {},
  "error": null,
  "onFail": "stop",
  "seconds": null,
  "reason": null,
  "skippedBy": null,
  "fromRunId": null
}
```

`status` is `waiting`, `running`, `passed`, `failed` or `skipped` (a delay the person skipped). A delay that runs has `plannedEndAt`. An item carried over by Continue has `fromRunId`, the run it passed in. The run itself has the items' output joined in `stdout` and `stderr` (what a later step's `stdin` or a `when` output rule reads), the captures of the items that passed, and an `error` such as `item 3 failed`. A step hidden from agents hides each item's output, captures and error as it hides a run's. You get one `step-done` or `step-failed` event when the step ends, not one per item. Every item also has `maxAttempts`, `endsBy` and `nextAttemptAt` (null except on a wait or a retried item), and a wait or retried item has `attempts`: see [Waits and retries](#waits-and-retries).

### Waits and retries

A **wait** item runs a command until its checks pass (1.4.10): the general poll, instead of a loop with `sleep`. Each attempt runs the command on its own connection, in the step's `workdir`; an attempt passes when the command exits 0 and every check passes. A failed attempt means "not yet": Runbooks waits the schedule's delay and tries again. The item fails when a `stopIf` check matches (at once: no point waiting, the job failed), or when the attempts or the time run out. A **run** item with `retry` runs a flaky command again on the same schedule when it fails.

Instead of this loop, which the [sleep ban](#no-sleep-in-commands) refuses:

```sh
for i in $(seq 1 120); do
  sudo bash setup-deptrack.sh status | grep -q 'mirror osv: COMPLETED' && break
  sleep 30
done
```

write a wait item:

```json
{
  "type": "wait",
  "label": "OSV mirror synced",
  "command": "sudo bash setup-deptrack.sh status",
  "checks": [{ "type": "contains", "text": "mirror osv: COMPLETED" }],
  "stopIf": [{ "type": "contains", "text": "mirror osv: FAILED" }],
  "attempts": 120,
  "every": 30,
  "within": 3600,
  "timeoutMs": 30000
}
```

and a flaky download as a run item with retry:

```json
{
  "type": "run",
  "label": "Fetch the image",
  "command": "docker pull registry.example.test/app:1.2",
  "retry": {
    "attempts": 5,
    "backoff": "exponential",
    "every": 2,
    "jitter": "equal",
    "retryOn": ["exit", "timeout"]
  }
}
```

| Field       | On                     | Meaning                                                                                                                                                                                                             | Default         | Limits                        |
| ----------- | ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------- | ----------------------------- |
| `checks`    | wait                   | What "ready" looks like, as for a step. At least one.                                                                                                                                                               | (required)      | 20                            |
| `stopIf`    | wait                   | Checks on each attempt's output; when one **matches** (passes), the item fails at once. It wins over checks that pass. Output checks only (no `value` checks).                                                      | none            | 20                            |
| `within`    | wait (required), retry | Seconds for all attempts and delays together. No attempt starts after it, and an attempt's time limit is cut to the time left.                                                                                      | retry: 7200     | 1 to 7200 (2 hours)           |
| `attempts`  | wait, retry (required) | The most attempts, the first one included.                                                                                                                                                                          | wait: 500       | wait 1 to 500, retry 2 to 500 |
| `every`     | both                   | Seconds: the first delay, and the step of a linear backoff.                                                                                                                                                         | 5               | 1 to 3600                     |
| `backoff`   | both                   | `fixed`: every delay is `every`; `linear`: `every × n`; `exponential`: `every × factor^(n−1)`, where n is the attempt that failed.                                                                                  | `fixed`         |                               |
| `factor`    | both                   | Exponential only (400 with any other backoff).                                                                                                                                                                      | 2               | 1.1 to 10                     |
| `maxDelay`  | both                   | Seconds: the longest one delay may get. At least `every`.                                                                                                                                                           | 300, or `every` | 1 to 3600                     |
| `jitter`    | both                   | After the cap: `none`; `full`: a random delay from 0 to the delay; `equal`: half the delay plus a random part of the other half.                                                                                    | `none`          |                               |
| `retryOn`   | retry                  | Which failures get another attempt: `exit` (non-zero exit code), `check` (exit 0, a check failed), `timeout`, `connect` (no connection or an error before the command ran). Another failure fails the item at once. | all four        | at least one                  |
| `timeoutMs` | both                   | The time limit of one attempt.                                                                                                                                                                                      | 120000          | 1000 to 600000                |

- Bad values are refused with 400 and a message that names the field, such as `sequence[1].within must be an integer from 1 to 7200`, on create, add-steps, update-step, amend and through MCP. `retry` is refused on an `interactive` item.
- The page and your view show the planned schedule before Run: the step's `schedules` lists `{item, attempts, maxSeconds, text}` for each wait or retried item, such as `"up to 120 attempts, every 30 s, at most 1 h"`. The person approves it with the commands: the schedule is part of the sequence's text and hash.
- The server runs the attempts after the Run answer, also with the page closed, as the person who pressed Run. Before each attempt after the first it checks that the person may still connect to the host; if not, the item fails and the sequence stops, whatever `onFail` says. One Run press covers all its attempts: they never ask the repeat question.
- While a wait or retried item waits for its next attempt, the person may press **Try now** (the delay ends and the next attempt starts) or **Stop**. A Termix restart fails the item and its attempt as interrupted; the person continues from that item, and the wait starts again at attempt 1.
- Captures come only from the attempt that passed; the item's `stdout`, `stderr`, `exitCode` and `checks` are the last attempt's.
- You get **one** event when the step ends, never one per attempt (the fleet limit is 10 messages an hour).

Each wait or retried item in a run has `attempts`, oldest first:

```json
{
  "attempt": 3,
  "status": "failed",
  "startedAt": "...",
  "finishedAt": "...",
  "exitCode": 0,
  "stdout": "mirror osv: RUNNING\n",
  "stderr": "",
  "truncated": false,
  "timedOut": false,
  "error": null,
  "checks": [
    {
      "label": "the output contains 'mirror osv: COMPLETED'",
      "ok": false,
      "detail": "..."
    }
  ],
  "stopIf": [
    {
      "label": "the output contains 'mirror osv: FAILED'",
      "ok": false,
      "detail": "..."
    }
  ],
  "why": "check"
}
```

`status` is `running`, `passed` or `failed`. `why` says why an attempt did not pass: `exit`, `check`, `timeout`, `connect`, `stop-if`, `stopped` or `interrupted` (null when it passed). A `stopIf` result with `ok: true` matched. While an item runs, the step has `attempt`: `{item, attempt, of, nextAt, endsBy}` (the item's number, the attempts made so far, the most it may make, when the next one starts or null while one runs, and when its time limit ends); otherwise `attempt` is null. On a step hidden from agents, each attempt's `stdout`, `stderr` and `error` read `[hidden by owner]` and `truncated` is false; the attempt count, times, exit codes, check and stopIf results and `why` stay visible, as an item's do.

**An attempt's output is read on its own.** `GET /runbooks/{id}` and `get_runbook` list each item's attempts **without output** (`stdout` and `stderr` null): a run may hold hundreds of them. The item itself carries its last attempt's output. Read one attempt with `GET /plugin-api/runbooks/agent/runbooks/{id}/runs/{runId}/items/{item}/attempts/{attempt}` (MCP `get_attempt` with `runbookId`, `runId`, `item`, `attempt`), hidden on a hidden step as above. What is kept: the last attempt of an item keeps its whole output (256 KB per stream); an earlier attempt keeps the last 4 KB of each stream (`truncated: true`), and the earlier attempts of one item keep 256 KB together (none after that); one run keeps 8 MB of output, past which an attempt or item keeps the last 4 KB of each stream.

**Try now and Skip** start the next attempt or item sooner, as the person who pressed Run: only that person, or a person who may connect to the step's host, may press them (403 `not-your-run` otherwise).

### Wait events

The **wait events** (1.4.10) are items that wait until a state holds, checked by Termix itself: no loop, `grep` or `test` runs on the host. Each polls on the [wait item's schedule](#waits-and-retries) (`within` is required, up to 7200 seconds; `every`, `backoff`, `factor`, `maxDelay`, `jitter`, `attempts`; `timeoutMs` is one check's limit, default 30000), and each check is an attempt in the item. Use them instead of a wait item that runs `docker inspect`, `systemctl`, `curl` or `test -f`.

| Type        | Waits until                                                          | Fields                                                                       | How Termix checks it                                                                                                                                                  | Hosts             |
| ----------- | -------------------------------------------------------------------- | ---------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------- |
| `container` | a container is `healthy`, `running`, `exited` or `gone`              | `name`, `state` (required)                                                   | one fixed `docker container inspect --format '{"State":…,"RestartCount":…}' -- '<name>'` as the SSH user, read as JSON                                                | Linux             |
| `unit`      | a systemd unit is `active`, or `finished` with `Result=success`      | `name`, `state` (required)                                                   | one fixed `systemctl show --timestamp=unix -p LoadState,ActiveState,SubState,Result,… -- '<unit>'`, read as `key=value`                                               | Linux             |
| `log`       | a line written after the step started matches `pattern`              | `container` or `unit`, `pattern`, optional `failPattern`, `sudo` (unit only) | `docker logs --timestamps --since <start> -- '<name>'`, or `[sudo -n] journalctl -u '<unit>' --since @<start> -o json --output-fields=MESSAGE`; matched in JavaScript | Linux             |
| `http`      | an address answers with `status` (default 200) and `contains`        | `url`, `status`, `contains`, `servername`                                    | a loopback URL: a GET over a TCP channel from the host to its own loopback; any other https URL: from Termix itself                                                   | all               |
| `port`      | a TCP port on the host's loopback is `open` (default) or `closed`    | `port`, `state`, `host` (`127.0.0.1` default or `localhost`; never `::1`)    | a TCP channel from the host to that port, through the SSH connection (`forwardOut`)                                                                                   | all               |
| `file`      | a path `exists` (default), is `nonEmpty` or is `gone`                | `path`, `state`, `sudo`                                                      | SFTP `stat` as the SSH user; `sudo: true` runs one fixed `sudo -n stat -L -c '%s %F' -- '<path>'` instead                                                             | all (sudo: Linux) |
| `job`       | a long command started in the background ended with `Result=success` | `command`, `unit` (default `runbooks-job-<run>-<item>`), `within` up to 7200 | `sudo -n systemd-run --unit=… --property=RemainAfterExit=yes -- /bin/sh -c '<command>'`, then the unit check and its journal each check                               | Linux             |

**The real loops these replace:**

A deploy, then "wait until the container is healthy", the most common wait:

```json
{
  "title": "home-server: Enforcarr on the farm image",
  "hostId": 1,
  "workdir": "/mnt/sdd/services/media-server",
  "sequence": [
    {
      "type": "run",
      "label": "Deploy",
      "command": "sudo paseo-deploy up media enforcarr"
    },
    {
      "type": "container",
      "name": "enforcarr",
      "state": "healthy",
      "within": 180
    },
    {
      "type": "http",
      "url": "https://127.0.0.1:8443/health",
      "servername": "enforcarr.example.com",
      "contains": "ok",
      "within": 60
    }
  ]
}
```

instead of `sudo paseo-deploy up media enforcarr && for i in $(seq 1 36); do docker inspect -f '{{.State.Health.Status}}' enforcarr | grep -q healthy && break; sleep 5; done`.

A backup that runs longer than the 10-minute limit of one command, followed to its end, then its log checked:

```json
{
  "sequence": [
    {
      "type": "job",
      "label": "Nightly backup",
      "command": "restic backup /srv --tag nightly",
      "unit": "restic-nightly",
      "within": 7200,
      "every": 30
    },
    {
      "type": "log",
      "unit": "restic-nightly.service",
      "sudo": true,
      "pattern": "snapshot [0-9a-f]+ saved",
      "failPattern": "Fatal:",
      "within": 60
    }
  ]
}
```

instead of `sudo systemd-run --unit=restic-nightly restic backup /srv` in one step and `until ! systemctl is-active -q restic-nightly; do sleep 30; done` in the next.

A unit started without waiting, then "until it finished", and a file it writes:

```json
{
  "sequence": [
    {
      "type": "run",
      "command": "sudo systemctl start --no-block enforcarr-migrate.service"
    },
    {
      "type": "unit",
      "name": "enforcarr-migrate.service",
      "state": "finished",
      "within": 600,
      "every": 10
    },
    {
      "type": "file",
      "path": "/srv/enforcarr/migrated.ok",
      "sudo": true,
      "within": 30
    }
  ]
}
```

A port that must close after a stop: `{ "type": "port", "port": 5432, "state": "closed", "within": 60 }`.

**What each reads, and when it fails at once:**

- `container`: a container that is not there yet is "not yet" for `healthy`, `running` and `exited`, and passes `gone`. While it waits for `healthy` or `running`, a container that **exited** or whose **restart count grew** since the first check fails the item at once. `healthy` on a container with no `HEALTHCHECK` fails at once (wait for `running` instead). Permission denied on the Docker socket fails at once.
- `unit`: an end (`ExecMainExitTimestamp`) before the step started belongs to an earlier run and does not count. `finished` passes on a unit that ran to its end with `Result=success` since then; a unit that **failed** since then fails at once, for `active` too. A unit that is not loaded fails at once: its name is wrong, or it was a transient unit that ended and systemd removed (use a `job`). It needs systemd 248 or later (`--timestamp=unix`).
- `log`: reads only lines written after the step started (after Continue, after the first item's start in the first run), each line once: the next check reads after the last time (Docker) or the last journal cursor. Each line is cut to 4096 characters. `pattern` and `failPattern` are JavaScript regular expressions of up to 200 characters, one line, with no repeated group that holds a repeat or alternatives, at any depth (such as `(a+)+`, `((a+))+` or `(a|aa)+`); patterns never take `{{name}}` values. They run with a time limit (250 ms for all the new lines of one check): a pattern that takes longer fails the item with `result` `pattern too slow`. The first new line that matches `failPattern` fails the item; the first that matches `pattern` passes it. A unit's journal without `sudo` needs an SSH user in the `adm` or `systemd-journal` group.
- `http`: a URL on `127.0.0.1` or `localhost` goes through the SSH connection to the **host's own** loopback, always opened to the literal `127.0.0.1` (the URL keeps `localhost` for the `Host` header and the certificate check). A URL on `[::1]`, and a `port` item with `host: "::1"`, are refused when written (400, "write 127.0.0.1; Termix's SSH key allows forwarding to 127.0.0.1 only"): the key's `permitopen="127.0.0.1:*"` lets sshd forward to that address as written, and it refuses `localhost` and `::1`. Any other URL must be `https://` and goes from Termix itself (core's `ctx.fetch`), never to Termix's own loopback, its own addresses, `0.0.0.0`, `::` or a link-local address, in any spelling (`[::ffff:127.0.0.1]`, `[64:ff9b::7f00:1]`); such an address in the URL is refused when written (400), and a name that resolves to one fails the item (`address refused`). The certificate is **always** checked: against `servername` (loopback URLs only) or the URL's host name, with the public roots plus the admin's **Extra trusted CAs**. Plain `http://` is allowed only to the host's loopback (the bytes stay inside the SSH connection). Redirects are not followed: a `301` is a status like any other. The first 64 KB of the body are read; the item shows the status line and the first 2 KB. A certificate that fails the check, a closed port, a `503` are all "not yet", so a proxy that shows its default certificate while it starts does not fail the item; the words say what the last check read.
- `port`, and `http` to a loopback URL: a channel the host's SSH server refuses as **administratively prohibited** (the SSH key Termix uses has `no-port-forwarding`, or its `permitopen` does not allow the port) fails the item at once with words that say so; it is never read as "closed". The key needs `permitopen="127.0.0.1:*"` and `permitlisten="127.0.0.1:1"` instead of `no-port-forwarding`: the host's own ports, and no reverse forwards.
- `file`: SFTP works with the key as it is. "Permission denied" fails at once (set `sudo: true` on Linux). `nonEmpty` on a directory fails at once.
- `job`: the first check starts the unit; each check reads its state, then the journal lines since the last check, which stream into the item. It passes when the unit ended with `Result=success`, fails at once when it failed, and then stops and unloads the unit (`systemctl stop`, `reset-failed`). **Stop**, or running out of `within`, stops the unit too. A unit of that name that is already loaded fails at once. The command runs as root (`sudo -n`), in the step's `workdir` (`--working-directory`), with systemd's environment, not a login shell's. The [sleep ban](#no-sleep-in-commands) reads it. A Stop while `systemd-run` starts it stops the unit too. The journal is shown with secrets, and hidden input typed into an earlier item, replaced. A Termix restart, or Runbooks being stopped, leaves the unit running; Continue starts the job again (a new run gets a new default unit name; with your own `unit` name, stop the old one first).

**Names and values.** Names, paths, units, URLs and `servername` are checked when the step is written (400 with the field's name, on create, add-steps, update-step, amend and MCP), and go into the fixed commands in single quotes after `--`, so they are never read as an option or as shell text. They may hold `{{name}}` values, also from an earlier item's capture; the filled value is checked again before the item runs, and a value that is not a valid name fails the item.

**Windows hosts.** `container`, `unit`, `log`, `job` and a `file` with `sudo` need a Linux host. They are refused when written (400, `code` `linux-only`) for a host whose Termix tags include `windows` (`list_hosts` shows `"windows": true`, kept when a person saves the token's hosts), and for a host a run found to be Windows. Termix tells plugins nothing about a host's system, so Runbooks reads the SSH server's version string from the handshake (`OpenSSH_for_Windows_9.5`): a Linux-only event on such a host fails at once with words that say so, and Runbooks remembers the host until Termix restarts. `port`, `http` and `file` without `sudo` work on Windows hosts (SFTP paths look like `/C:/Users/...`).

**What you read.** An event item's `command` is what it checks: the fixed command with `# until ...`, or the channel it opens (`"TCP 127.0.0.1:8443 on home-server, through the SSH connection: until open"`). Each attempt has `result`, the state it read in fixed words (`healthy`, `exited (1)`, `restarting (restart 3)`, `active (running)`, `failed (exit-code, status 3)`, `finished (success)`, `HTTP 503`, `HTTP 200, text not found`, `certificate not trusted`, `port closed`, `forwarding refused`, `file exists`, `file exists, empty`, `not there`, `no match yet (12 new lines)`, `matched`, `Windows host`); the item's `result` is the last one. `why` is `not-yet` (not the state yet), `fail-state` (a state that fails at once), `timeout`, `connect`, `stopped` or `interrupted`. The attempt's `stdout` and `stderr` are what the check read (the command's output, the HTTP status and body, the journal messages); a job's item keeps its whole journal. On a step hidden from agents, `stdout`, `stderr` and `error` read `[hidden by owner]`; `result` stays visible, as an exit code does: it is built from fixed words and numbers only, never text from the host.

### No sleep in commands

Runbooks refuses a command that waits a fixed time (1.4.10), in `command` and in every run and wait item, when you create a runbook, add steps, change a step or amend one: 400 with `code` `sleep` and a message that points to the `delay` and `wait` items. What counts as a wait:

- `sleep` as a word followed by a duration, a variable, a quote or a parenthesis, past options and `--`: `sleep 5`, `/usr/bin/sleep 0.5`, `sleep "$DELAY"`, `sleep infinity`, `sleep -- 5`, `sleep${IFS}5`, `bash -c 'sleep 5'`, `time.sleep(5)`, `await sleep(100)`. The word is read as the shell reads it, so `s''leep 5`, `s\leep 5` and `"sl"eep 5` are `sleep 5`.
- `Start-Sleep`, with any arguments; `timeout /t <n>`; `read -t <n>`; `timeout <n>` right before a command that never ends by itself (`tail -f`, `journalctl -f`, `docker logs -f`, `cat` with no file, `read`, `yes`, `wait`, a `ping` with no count); `ping -n <n>` or `ping -c <n>` to the host itself (127.0.0.1, localhost, ::1) or with its output thrown away (`>nul`, `> $null`).
- Values are read once filled in: a Run whose values make a command wait is refused (400 `sleep`), and a sequence item whose value, captured by an earlier item, makes it wait fails before it runs.

Not a wait: `sleep` inside a longer word (`sleeping`, `--no-sleep`, `sleep.target`), `sleep` followed by other words (`echo "time to sleep now"`), `timeout 30 curl ...` (a time limit), `docker compose up --wait`, and a `ping` that tests a network address. The text is read as it is, inside quotes too, so `echo "sleep 5 minutes"` is refused: reword it.

Make the step a sequence instead, with the commands before and after the wait as run items and a `delay` item between them. A loop that polls (`until curl ...; do sleep 5; done`) is refused too: use a [wait event](#wait-events) (container, unit, log, http, port, file, job), or a [wait item](#waits-and-retries) that runs the check until it passes. A `job` item's command is read too. The ban reads a wait item's command as well. Steps stored before keep running. An admin can turn the ban off in the plugin's settings (**Refuse sleep in commands**); it is on by default.

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
- Agents see the source, and on each run `stdin: { ...source, "bytes": 1229 }`, never the input. A hidden step's run, and a run that read a secret, have no `bytes`.

Read a config, then check it:

```json
"steps": [
  { "title": "Read the config", "hostId": 3, "command": "cat /etc/app/config.json" },
  { "title": "Check the version", "hostId": 3, "command": "jq -e '.version == \"2\"'",
    "stdin": { "from": "step", "step": 1, "stream": "stdout" } }
]
```

### Conditional steps

A step that is needed only after some results ("only if step 8 or 9 failed", "skip this if step 1 printed X") gets a `when` rule (1.4.6) instead of a line in its title or body. The rule reads **earlier steps only**, so it can never wait on a later step or loop.

```json
{
  "title": "Way back",
  "hostId": 3,
  "command": "app rollback",
  "when": {
    "any": [
      { "step": 8, "status": "failed" },
      { "step": 9, "status": "failed" }
    ]
  }
}
```

```json
{
  "title": "Turn on HTTPS certificates",
  "hostId": 3,
  "command": "app https on",
  "when": {
    "step": 1,
    "output": { "type": "contains", "text": "HTTPS certificates: OFF" }
  }
}
```

| Rule                                                      | Holds when                                                                                                                 |
| --------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `{ "step": N, "status": "done" }`                         | step N ended that way: `done`, `failed`, `skipped`, `not-needed`, or `ran` (it has a finished run, whatever the result)    |
| `{ "step": N, "output": <check> }`                        | step N's latest finished run passes the check: any [check](#checks) type, `{{name}}` values filled in, with secrets hidden |
| `{ "value": "name", "equals": "..." }` or `"matches"`     | the runbook value (the author's or a capture) has this value; with neither, that it is set                                 |
| `{ "step": N, "chose": "rollback" }`                      | the person chose that option in [decision step](#decision-steps) N; a decision skipped or not made matches none            |
| `{ "all": [...] }`, `{ "any": [...] }`, `{ "not": rule }` | combines rules, at most 4 levels deep and 20 rules in a step's `when`                                                      |

- `step` is a number such as `3`, or `"3a"` for an amendment, as in `stdin`. A rule that names this step, a later step, a step that is not there, or a value check on a value the step does not capture is refused with 400, naming where in the rule.
- A rule that names a step an amendment replaced reads the replacement (`9` reads `9a`), as long as the replacement is before the step with the rule.
- An output rule on a step with no finished run (skipped, or no command) does not hold; test its `status` for that case. For a terminal run it reads the pasted output, for a decision the chosen ids, one per line.
- A rule reads the runbook's own values and the values that steps **before** it captured, never a later step's: `{ "value": "mode" }` on step 2 does not change when step 4 captures `mode` again, and nor does `{{mode}}` in its output rule.
- A step a rule names cannot be removed (409 `when`) or moved after the step with the rule (400). Change the rule first with `update_step`; `when: null` removes it.
- **A rule cannot read hidden output.** Every rule reads what you see: the output and captured values of a step with `hideOutputFromAgents` read `[hidden by owner]`, and a hidden value reads `[hidden by owner]` wherever another step's output or capture holds it, and in `{{name}}`. This holds for every rule, also one written before the person hid the step. Writing one is refused (400): an output rule on a hidden step, a value such a step captures, or such a value as `{{name}}` in an output rule.
- To branch on what a hidden step printed, give that step a check, and give the later step a status rule. The check reads the real output when the person runs the step, and the person approves it with the command:

  ```json
  { "title": "Read the token", "hostId": 1, "command": "show-token",
    "hideOutputFromAgents": true,
    "checks": [{ "type": "contains", "text": "scope: admin" }] },
  { "title": "Ask for an admin token", "when": { "step": 1, "status": "failed" } }
  ```

- A change to a step's `captures`, `decision` or `interactive` that breaks a rule that reads the step (a capture or option it names, a hidden value, `stream: "stderr"` on an interactive step) is refused with 409 `when`; change the rule first. An amendment with `kind: "replace"` is checked the same way, since a rule that names the replaced step reads the replacement.
- An output rule with `stream: "stderr"` on an interactive step is refused (400): its stdout and stderr are one stream.
- An output rule on a decision step that is not done (reopened, or skipped) does not hold: the step has no choice, so no output.
- `condition.rule` and `condition.reason` show `[hidden by owner]` in place of a value from a hidden step.
- A Decision step cannot have `hideOutputFromAgents` (400).

Runbooks works out each rule's state every time the runbook is read, and never stores it, so reopening an earlier step and running it again changes the answer. Each step has `condition` (`null` without a rule):

```json
"condition": { "state": "not-met", "rule": "step 8 failed or step 9 failed",
               "reason": "step 8 is done and step 9 is done", "notNeeded": true }
```

- `state` is `waiting` (a step it names has not ended, or a value it reads is not set while an earlier step is pending), `met` or `not-met`. `reason` says why, and never quotes output.
- A pending step that never ran and whose rule is `not-met` is **not needed** (`notNeeded: true`). It counts as ended: for the order (later steps do not wait for it), for `nextStepId`, for `progress` (`notNeeded` counts them), for `agent-turn` (an agent step that is not needed gets no event, and the next agent step does) and for a wait timer (`waitAfterPreviousSeconds` counts from the last step before it that is needed).
- The person sees a waiting step with "Only if step 8 failed or step 9 failed", and a step that is not needed as one grey line with the reason.
- The person can still start a step that is not needed: Run, Send to terminal, Make it or Save, and Done or Failed are refused with 409 `not-needed` (with `rule` and `reason`) until they confirm "Run anyway?" (`conditionAnyway: true`). That start is audited, once every other question passed. `complete_step` on an agent step that is not needed is refused with 409 `not-needed`.
- A step that already ran is history: its rule no longer makes it not needed.
- Patterns cost time. Runbooks keeps what a pattern said of a finished run (and of a value), so each is tested once, and the patterns of one read share a limit of 500 ms (each still stops at its own 250 ms, and does not match then). A rule whose pattern the shared limit stopped is `waiting`, with the reason "not worked out yet", until a later read gets to it. Keep patterns simple.

### Decision steps

When the way on depends on a person's judgment ("only if needed", "if the lead says so"), give the person a **Decision** step (1.4.6): options you write, chosen with radio buttons or check boxes, never free text. Later steps read the choice with a `when` rule, so the same choice always gives the same runbook.

```json
{
  "title": "Which way do we go?",
  "body": "Step 11 failed. Choose how to go on.",
  "decision": {
    "options": [
      {
        "id": "retry",
        "label": "Fix it and try again",
        "description": "The agent amends step 11."
      },
      { "id": "rollback", "label": "Go back to the old release" },
      { "id": "stop", "label": "Stop here and keep it as it is" }
    ],
    "value": "path"
  }
}
```

```json
{
  "title": "Roll back",
  "hostId": 3,
  "command": "app deploy --way {{path}}",
  "when": { "step": 12, "chose": "rollback" }
}
```

| Field      | What it is                                                                                                                                                             |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `options`  | 2 to 10, each `{ id, label, description? }`: `id` is 1 to 40 of `a-z`, `0-9` and `-`; `label` one line, up to 120 characters; `description` short Markdown, up to 1000 |
| `multiple` | `false` (the default): radio buttons, exactly one choice. `true`: check boxes, from `min` (default 1) to `max` (default all)                                           |
| `value`    | Optional: a runbook value that gets the chosen ids, joined with commas in your order, for later commands (`{{path}}`); it has no value while the step is not done      |

- A decision step has no host, command, checks, captures, stdin or wait timer, and it is always a person's: `owner: "agent"` is refused (400). Agents read decisions; they never make them.
- The person presses **Confirm** (`POST /steps/{id}/decide` with `{ revision, chosen }`). The step ends done with a run in mode `decision` whose `stdout` is the chosen ids, one per line, so `stdin` and output rules can read it too. `step-done` (when `notify` lists it) has the note "chose rollback".
- `get_runbook` shows `decision` and, while the step is done, `choice: { chosen, by, at }`.
- **Reopen** lets the person choose again. Steps that already ran on the old choice stay as they are; the page names them before it reopens. Steps that have not run follow the new choice.
- A rule `{ "step": N, "chose": "<id>" }` must name an earlier decision step and one of its option ids (400 otherwise). For several options, combine rules: `{ "all": [ { "step": 5, "chose": "dns" }, { "step": 5, "chose": "tls" } ] }`. A decision that was skipped matches no `chose` rule; test `{ "step": 5, "status": "skipped" }` for that.

### VM steps

When a step is "start the build VM" or "shut down the test VM", give the person a **VM step** (1.4.7) instead of a PowerShell command: one button, and **HAW VM Manager** does the action through its own fixed `vmctl` command, as the person who presses it. HAW's roles and the host's own limits (its name pattern, its protect list, its ceilings) apply exactly as in HAW's tab, and HAW keeps the action in its record ("via runbooks: runbook 12 step 3"). It needs HAW VM Manager 1.0.3 or later, and an admin must add `runbooks` to HAW's **Plugins that may act for a person**; until then the step says why it cannot run.

```json
{
  "title": "Start the build VM",
  "vm": {
    "host": 4,
    "name": "wyatt-pc-builder",
    "action": "start",
    "waitFor": "running",
    "waitSeconds": 300,
    "value": "build"
  }
}
```

```json
{
  "title": "Build on it",
  "hostId": 7,
  "command": "ssh builder@{{build.ip}} make release"
}
```

| Field         | What it is                                                                                                                                                                                      |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `host`        | A host HAW manages as a VM host, and one the token may name. `GET /vms` lists them                                                                                                              |
| `name`        | The VM's name, as `GET /vms?host=4` shows it: 1 to 100 characters, no `*`, `?`, `[`, `]` or control characters. Values (`{{name}}`) are not filled in                                           |
| `action`      | `start`, `stop` (a shutdown the guest does), `restart`, `show` (reads the VM, changes nothing) or `console` (opens the VM's console in Remote Desktop; the person marks the step done)          |
| `force`       | `stop` and `restart` only: turn off or hard reset without asking the guest. The card shows it in red, and the person confirms it on its own                                                     |
| `waitFor`     | The state to wait for: `running`, `off`, `starting`, `stopping`, `saved`, `paused` or `other`. Default: `running` for `start` and `restart`, `off` for `stop`, none for `show`. `null`: no wait |
| `waitSeconds` | How long to wait, 1 to 600. Default 300. The step fails when the time is up and says the last state                                                                                             |
| `value`       | A prefix: the step sets `{{build.state}}`, `{{build.id}}` and, when the VM has an address, `{{build.ip}}` (the first IPv4 address, else the first) and `{{build.addresses}}` (comma-separated)  |

- A VM step has no `hostId`, `command`, `captures`, `secretCaptures`, `stdin`, `timeoutMs` or `interactive`, and it is always a person's: `owner: "agent"` is refused (400). Agents read VM steps and their runs; they never act on a VM.
- Its run is in mode `vm`. While it waits, its output says each state the VM passes through, as Runbooks reads it every 2 seconds. When it ends, its `stdout` is the VM's details as JSON, then one summary line: `wyatt-pc-builder is running, 192.0.2.10`. `checks` (`contains`, `notContains`, `matches`, `notMatches`) and `when` output rules read it as they read a command's output; there is no exit code. A console's run waits for the person's **Done** or **Failed** and has no checks; its `stdout` is one line, `The console of build-1 opens in Remote Desktop on host-3`.
- The usual questions apply before HAW is asked: the revision, the order, the wait timer, the `when` rule, and a repeat (the step ran before, or the same action ran on the same VM in the last 24 hours; not for `show` and `console`). A host that refuses (`protected`, `name-not-allowed`, `not-found`, `wrong-state`, `ceiling`) fails the step with HAW's words, and the page shows "the host refuses this" before anything is pressed when it can tell.
- `GET /vms` (MCP `list_vms`) is read only. Without `host` it answers `{ hosts: [{ hostId, name, verbs, lastCheckedAt, readAt }] }`, the token's hosts that HAW manages, with the verbs each host's `vmctl` offers. With `host` it answers `{ host, vms: [{ name, cpus, memoryMB, allowed, protected }] }`.
- The answer is a copy, not a live read: an agent request has no Termix login, so Runbooks cannot ask HAW for it. When a person makes the token or saves its hosts in the Runbooks tab, Runbooks reads HAW as that person, for an agent (HAW only lists for it), and keeps the copy with the time it was read (`readAt`). It has no VM state: the card reads the state when the person opens the step. A VM made later is in the copy only after a person saves the token's hosts again; ask them to when a VM is missing.
- 404 for a host the token may not use or HAW does not manage. 409 (`code: "no-vm-copy"`) when the copy cannot say: HAW was not installed, did not let Runbooks act for people, or the person who saved the hosts had no HAW role (the error says which), HAW could not list that host's VMs then, or the token's hosts were saved before 1.4.7.
- A VM step's `host` must be one of the token's hosts (400), and, when the copy can say, one HAW manages (400). A VM name is checked when the person opens the step.
- `hideOutputFromAgents` works on a VM step: agents then read `[hidden by owner]` for its output and for each of its values. Its `state` value is not masked in other steps' text; a step that reads it is hidden instead (see "Values and placeholders").

### Run or Send to terminal

A step that Termix runs has two buttons: **Run** starts the command over a connection of its own, and **Send to terminal** types it into a terminal for the person. When only one of them works, say so with `runIn` (1.4.6) instead of a line in the title or body: people press Run anyway.

| `runIn`              | The person sees          | The server                                   |
| -------------------- | ------------------------ | -------------------------------------------- |
| `"either"` (default) | Run and Send to terminal | takes both                                   |
| `"terminal"`         | Send to terminal only    | refuses Run with 409 `terminal-only`         |
| `"run"`              | Run only                 | refuses Send to terminal with 409 `run-only` |

- Use `"terminal"` for a command that opens a browser or must run in the person's own shell, such as `bao login -method=oidc`. A command that only asks for a password or a token can stay a Run: the person types into it from the page (see [Typed input](#typed-input)).
- `runInReason` is one line the person sees next to the button, such as "it opens your browser". The 409 answer carries it as `reason`.
- Only a step with `hostId` and `command` may set `"terminal"` or `"run"`. An agent step, a step run outside Termix, a secret step and a step with no command are refused with 400.
- `"terminal"` cannot have `stdin` (400): Send to terminal cannot give a command its standard input. A step with `stdin` already refuses Send to terminal (409 `stdin-run-only`).
- The refusal comes before the questions about the order, the wait timer and a repeat, since no answer to them changes it.

```json
{
  "title": "Sign in to OpenBao",
  "hostId": 3,
  "command": "bao login -method=oidc",
  "runIn": "terminal",
  "runInReason": "it opens your browser"
}
```

### Output read from the terminal

**Off since 1.4.12.** It did not fill the box on every terminal (BUG-024), so Send to terminal no longer reads the terminal: the person pastes the output, as before 1.4.10, and new runs have `outputSource` `"pasted"`. Runs from 1.4.10 and 1.4.11 keep the `outputSource` they had. Write a Send to terminal step that tells the person to paste the output. The rest of this section is how the reading worked in 1.4.10 and 1.4.11.

In 1.4.10 and 1.4.11, Send to terminal reads what the command prints into the **Mark done** box, so the person does not copy it from the terminal (on a phone they cannot). It only fills the box: the person checks the text, can change it, and presses **Mark done** or **Mark failed** as before. The box always says "Check the text before you save it" (or "The terminal waits for a password"); it never says the command finished. **Read again** reads the terminal again.

- The text is the run's `pastedOutput`, so checks, `captures`, `secretCaptures` and secret masking read it as they read a paste. The exit code stays empty: the person may enter one.
- The run's `outputSource` says where it came from: `"captured"` (read from the terminal, kept as read), `"captured-edited"` (read from the terminal, then changed by the person) or `"pasted"` (by the person). It is `null` on a run with no pasted output, on runs from before 1.4.10, and on a step hidden from agents. A step run outside Termix with output has `"pasted"`. It is what the person's page reported, not proof that the text was not typed by hand.
- The reading lives in the browser that pressed Send to terminal. After a reload, on another device, or with a Termix whose terminal does not offer it (such as plugin API 2), the box is empty and the person pastes, as before.
- The text starts only after the command's echo: the line the shell ends on Enter must be the prompt noted before the send, with the command. When the person changed the command first, or the echo cannot be followed, nothing is read and the person pastes. It ends at the next prompt (where bash 5.1+, zsh or fish turn line editing on again, or the noted prompt at the start of a line), at a cursor move to another row (`clear`, a progress display, tmux: a note says the end may be missing), at 256 K characters, or after an hour or the step's longer time limit. Commands the person types after it are not in the text. A terminal whose last line is not a prompt (a tmux status line, a message still printing) gets no reading: the person pastes.
- **Mark failed** sends the read text only if the person opened or changed the box; otherwise the run has no output, as before 1.4.10.
- For a command that only asks for a password, a Run with [Typed input](#typed-input) still keeps more: the exit code and the output as it arrives.

### Typed input

While a Run runs, the person who started it can type into the command from the runbook page (1.4.6): a line under the live output with **Send** (Enter) and **End input**, and an eye to hide what they type. This works on every Run without `stdin`, for programs that read standard input: `read`, `sudo -S`, many scripts. Write the step as a Run; do not tell the person to use Send to terminal and paste the output back.

Some programs read a terminal, not standard input, and stop with "a terminal is required" without one: `sudo` (without `-S`), `ssh` with a password, `ansible --ask-become-pass`. Set `interactive: true` on such a step, and its Run opens a terminal (pty) for the command.

```json
{
  "title": "Run the playbook",
  "hostId": 3,
  "command": "ansible-playbook site.yml --ask-become-pass",
  "interactive": true,
  "checks": [{ "type": "contains", "text": "failed=0" }]
}
```

- With a terminal, stdout and stderr come as one stream, in `stdout`. A check with `stream: "stderr"` is refused with 400; use `"stdout"` or `"any"`. Line ends, colour codes and title codes are taken out before the output is kept or checked.
- `interactive` cannot have `stdin` (the person types the input), `secretCaptures` (their output is held until the end, so the person could not see a prompt) or `runIn: "terminal"` (400). It works with `runIn: "run"` and with `when`.
- Only a step with `hostId` and `command` may set it (400 otherwise).
- A program with echo on (a shell, `read -r`) prints what the person types, and that is part of the output. A program that asks for a password turns echo off. Text sent hidden, 4 characters or longer, is replaced with `[secret:typed]` in the output and in what the checks read.
- The time the command waits for input counts toward `timeoutMs`. Give a step that waits for a person enough time.
- **Send** ends the line as a terminal's Enter does: CR on an interactive step (Windows OpenSSH with PowerShell's `Read-Host` may not take LF as Enter; Linux reads CR as LF), LF on any other Run. **End input** sends Ctrl-D on an interactive step (twice in mid-line, the first hands over the line as typed).
- **An interactive step on a Windows host** (OpenSSH under a terminal) differs from Linux in two ways:
  - The exit code may not come through: wyatt-pc reported 0 for PowerShell's `exit 7` (BUG-015; without a terminal its exit codes are real). Do not give such a step an `exitCode` check; have the command print its result and check that text instead: for example, end it by printing `exit=0` when it worked (`exit=7` when not) and check `{ "type": "contains", "text": "exit=0" }`.
  - Ctrl-D (**End input**) is the Linux and Unix end of input and may not end the input on Windows. Do not write a Windows step that waits for it; end such a command another way (a blank line, or a word it reads as the end).
  - Windows starts a terminal by painting every row empty. Those empty lines before the first text are taken out of the output (1.4.7).
- A pager waits for a key with a terminal: write `--no-pager` (`systemctl`, `journalctl`, `git`) in an interactive step's command.
- What the person types is never stored or shown to agents. A run has `inputCount`, the number of times the person typed or ended the input. Agents cannot type into a run.

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

### Make a secret and Ask for a secret

Do not tell the person to make a password in a password manager, or to copy a token from another site into OpenBao. Give the step `generate` or `ask` instead (1.4.2). The person clicks **Make it** or **Save**, and the value goes straight to where `store` says. Nobody sees it again: not the page, not you, not an event, the audit log or any output.

- **Make a secret**: `"generate": { "name": "db_password", "format": "alnum", "length": 32, "store": "runbook" }`. The server makes the value with `crypto.randomInt` for each character or word, so no character is likelier than another.
- **Ask for a secret**: `"ask": { "name": "cf_token", "label": "Cloudflare API token", "pattern": "[A-Za-z0-9_-]{40}" }`. The person types or pastes the value once, into a field that shows it while it is typed and has a **Hide** button. The value is trimmed, and `pattern` (optional, a JavaScript regular expression of up to 300 characters) must match all of it.

| `format`              | `length`                     | Default |
| --------------------- | ---------------------------- | ------- |
| `alnum` (the default) | 16 to 128 letters and digits | 32      |
| `hex`                 | 16 to 128 hex digits         | 64      |
| `base64url`           | 16 to 128 characters         | 43      |
| `words`               | 4 to 12 words, joined by `-` | 6       |
| `pin`                 | 4 to 12 digits               | 6       |

`words` picks from the [EFF long word list](https://www.eff.org/dice): 7776 words, about 12.9 bits each.

`store` says where the value goes:

- `"runbook"` (the default): the runbook's own secrets, like [captured ones](#secrets), for 7 days and deleted when the runbook ends. A later step reads it with `"stdin": { "from": "secret", "name": "db_password" }`.
- `{ "library": "mine/<path>" }` or `{ "library": "shared/<path>" }`, with an optional `"expires"` of 1 to 30 days: a new secret in the OpenBao Secrets library, the person's own or the shared one. Runbooks never replaces a secret that is there (409 `exists`). A later step reads it with `"stdin": { "from": "secret", "library": "mine/<path>" }`.
- `{ "app": "<app>/<host>", "field": "<field>" }`: a new field at `<app secrets folder>/<app>/<host>`, where other programs read their secrets. It needs OpenBao Secrets 1.0.5 or later, an app path its admin allows, and the person's **Create app secrets** permission. A field is never replaced (409 `exists`) and never read back, so no later step can read it.

A step with `generate` or `ask` is a person's step with no command. Refused with 400: `owner: "agent"`, `command`, `hostId`, `where`, `stdin`, `captures`, `secretCaptures`, `checks`, a step with both fields, and a bad `format`, `length`, `name`, `label`, `pattern` or `store`. A step that reads a secret by `name` needs an earlier step that captures it, or makes or asks for it with store `"runbook"`. You can never make, save or complete such a step: `complete_step` answers 403 `person-step`, and only a signed-in person's click runs it.

Its run has `"mode": "secret"`, and `secrets.made` says `{ name, how: "made" | "saved", store, where, expiresAt }`, never the value. Every later output of the runbook shows the value as `[secret:<name>]`, in steps that read it and in steps that do not (except an app field, which Runbooks never reads back). The person route is `POST /plugin-api/runbooks/steps/{id}/secret`; it answers 409 with `code` `stale`, `order`, `wait` or `repeat` like Run, and `no-secrets`, `app-store-unsupported`, `app-store-off`, `app-not-allowed` or `exists` when the store cannot take the value.

**By hand.** When OpenBao Secrets is not installed or not connected, or an app store meets an OpenBao Secrets older than 1.0.5, the step tells the person how to do it by hand. For Make a secret it gives the format and length to make in a password manager. Then it says where to save the value in OpenBao or Vault: KV engine `kv`, a path and a field (`runbooks/<runbook id>` and the secret's name for `"runbook"`; OpenBao Secrets' default folder `termix` for the library; the app secrets folder for an app). The person marks the step **Done**. A later step that reads the secret says where to get it, and does not run until OpenBao Secrets is connected.

```json
"steps": [
  { "title": "Make the database password",
    "generate": { "name": "db_password", "format": "alnum", "length": 32 } },
  { "title": "Set it", "hostId": 3,
    "command": "read -r PW && sudo -u postgres psql -c \"ALTER USER app PASSWORD '$PW'\"",
    "stdin": { "from": "secret", "name": "db_password" } },
  { "title": "Paste the Cloudflare token",
    "ask": { "name": "cf_token", "label": "Cloudflare API token",
             "store": { "app": "dns/web-1", "field": "cf_token" } } }
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
  "stdin": null,
  "secrets": null,
  "note": null,
  "startedEarlySeconds": null,
  "captured": {}
}
```

`mode` is `exec` (run over SSH), `terminal` (sent to a terminal; `pastedOutput` holds what the person pasted or checked, and `outputSource` whether it was `pasted`, `captured` from the terminal or `captured-edited`, see [Output read from the terminal](#output-read-from-the-terminal)), `manual` (a step with no command that the person marked **Done** or **Failed**; `hostId` is `null`, `command` is empty and `note` holds the person's note) or `agent` (an agent step the agent ended; `userId` is the token's name, `hostId` is `null`, `note` and `stdout` are what the agent handed in). `status` is `running`, `awaiting-output`, `done` or `failed`. `stdin` is the source and size of the standard input the run got, `secrets` the secrets it read and stored, by name, and `startedEarlySeconds` how much of the step's wait timer was left when the person started it anyway (`null` when it was not early).

While a command runs, its run has `status: "running"` and `running: true`, `stdout` and `stderr` hold the output that has arrived so far, and `lastOutputAt` is when it last printed anything (`null` before the first output). Read the runbook again to follow it; once a second is plenty. Output of a hidden step still reads `[hidden by owner]`. A run the person stopped ends `failed` with `error: "stopped by <user id>"`; a run cut short by a Termix restart ends `failed` with `error: "interrupted: Termix restarted while it ran"` and the output that had been saved. A failed run of a hidden step has `error: "[hidden by owner]"` whatever the reason, and its run that ended done has `error: null`. Agents cannot stop a run.

## MCP

`POST /plugin-api/runbooks/agent/mcp` is an MCP server over streamable HTTP: JSON-RPC 2.0, one JSON answer per request, no event stream and no session. It answers `initialize`, `notifications/initialized`, `ping`, `tools/list` and `tools/call`, with the same token.

| Tool             | What it does                                               |
| ---------------- | ---------------------------------------------------------- |
| `list_hosts`     | Hosts the token can use                                    |
| `list_vms`       | The token's VM hosts in HAW, or the VMs on one (read only) |
| `list_runbooks`  | Runbooks with progress; `folder` lists one folder          |
| `get_runbook`    | One runbook with steps, notes, runs and outputs            |
| `create_runbook` | Propose a runbook with steps                               |
| `update_runbook` | Change title, summary, values, status, owner or folder     |
| `add_steps`      | Add steps at the end or at a position                      |
| `update_step`    | Change a step that has not run                             |
| `remove_step`    | Remove a step that has not run                             |
| `reorder_steps`  | New step order                                             |
| `get_values`     | Effective values                                           |
| `get_attempt`    | One attempt of an item, with its output                    |
| `complete_step`  | End an agent step when it is the agent's turn              |
| `amend_step`     | Amend a step with a fixed version or a sub-step            |
| `list_events`    | Events of the token's runbooks after an id                 |

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

- Ask for one command per step, with an `expect` line, so each approval is small. Where commands belong together, ask for a sequence (one run item each) instead of a chain with `&&`, a `delay` item instead of a fixed `sleep`, and a `wait` item instead of a loop that waits for something to be ready.
- Ask for checks on each step that has an expected result, so a wrong result marks the step failed instead of passing unnoticed.
- Ask for a wait timer where a step must wait after the one before it, instead of "wait two minutes" in the text.
- Ask for checks before changes, and a check after each change.
- Ask the agent to read `get_runbook` after you run steps, and to add new steps rather than change ones that ran.
- Ask it to put names, paths and versions in values, so you can read them in one place.
- Ask it to hide output that could hold secrets.
- Ask it to pass secrets and earlier output with `stdin` and `secretCaptures`, never by putting them in a command, so you do not copy them from step to step.
- Ask it to use Make a secret (`generate`) for a new password and Ask for a secret (`ask`) for a token another site shows, instead of steps that say "make a password" or "paste the token into OpenBao".
- Ask it to set `owner` with its task, and to make its own work agent steps (`"owner": "agent"`) instead of steps that say "tell the agent". With notifications on, the agent hears when it is its turn; without them it can poll `list_events`.
