# Changelog

## 1.4.1

### Fixed

- Checks test the output with its secrets hidden, the same text Runbooks keeps and shows. Before, they read the raw output: a check for `token: [secret:api_token]` failed, and a check that named part of a secret's value passed or failed on its characters, so an agent could learn the secret one guess at a time. Captured values that a check reads are hidden the same way. This holds for Run, Send to terminal with Mark done, steps run outside Termix and agent steps.
- **Done** on a step run outside Termix needs pasted output when the step has checks: the button is off with "Paste the output first: at least one line.", as Mark done on a terminal run is, and the server refuses it with 400. **Failed** needs nothing. The hint also shows as text under the buttons, for phones.

### Added

- Step kinds. Each step shows who does it and how, read from the fields it already has: **Run here** (a command and a host; green, Play, "Run on <host>"), **Lead's step** (an agent step; blue, Bot, "<agent>'s step"), **Outside Termix** (a command and `where`; amber, External link, "Run outside Termix"), **In an app** (no command; violet, Mouse pointer, "Do it yourself") and **Finish** (the last step, with no command, whose title starts with "Finish"; neutral, Flag). The chips **Secret** (it captures or reads a secret) and **Wait** (it has a wait timer) go on any kind.
- The current step has a 2 px border and a soft glow in its kind's color. Pending steps have a stripe in their kind's color, dimmed once done; failed steps a red stripe, whatever their kind; replaced and skipped steps a grey one. The runbook list shows the next step's kind as a dot, an icon and its name (`nextKind` in `GET /runbooks`).
- Step colors. Admins set one color per kind for everyone, and each person can set their own, which win (setting `stepColors` in both scopes, `#rgb` or `#rrggbb` only, anything else refused on save). `GET /colors` answers the colors a person sees. Empty keeps the built-in color, which suits light and dark themes. Failed stays red.
- Kinds and marks are one registry, `src/shared/step-kinds.ts`: a new kind is one entry. See "Adding a step kind" in the README.

## 1.4.0

This update asks the admin to agree to two new capabilities: `network:outbound`, to send agent notifications to the webhook an admin sets, and `secrets:own`, to keep the webhook's signing secret sealed with Termix's installation key. Runbooks sends nothing until an admin turns notifications on.

### Added

- A runbook's owner. Agents set `owner: { task, agent, label }` on a runbook (create, `PATCH`, `create_runbook`, `update_runbook`): a task id (up to 64 characters), an address of the agent's session that a notification receiver understands (up to 200), and a label for the person (up to 80). The person sees "Agent: <label or token name> · task <task>" under the title.
- Agent steps. A step with `owner: "agent"` is work the agent does itself. The person sees "Waiting for the agent" with the agent's label and can only Skip or Reopen it; Run, Send to terminal and Done are refused with 409 `agent-step`. Its command, if any, is shown as "What the agent will run" and needs no host. Captures, secret captures, standard input, wait timers and `exitCode` checks are refused on it (400).
- `POST /agent/steps/{id}/complete` (MCP `complete_step`): `{ outcome: "done" | "failed", note?, output? }` (note up to 2000 characters, output up to 64 KB). Only for an agent step, once every earlier step ended; refused with 403 `person-step`, 409 `order`, 409 `ended` and 409 `closed`. It records a run in mode `agent` with the token's name, the note and the output, which the step's checks test. Audited.
- Events: `agent-turn` (an agent step became the next step), `step-failed` (with `reason` `exit`, `check`, `stopped`, `interrupted`, `secret` or `manual`), `runbook-done` (`done` or `abandoned`), `sent` and `step-done` (only when the runbook's `notify` lists it). `GET /agent/runbooks/{id}` lists the latest 100 as `events`; `GET /agent/events?since=<id>&limit=<n>` (MCP `list_events`) pages through all of the token's.
- `notify` on a runbook: the event types the webhook delivers for it, default `agent-turn`, `step-failed`, `runbook-done`, `sent`.
- Agent notifications, off by default. Admin settings **Notify agents**, **Webhook address** (https only; http is refused) and **CA certificate (PEM)**, and a section with **Make a new signing secret** (32 random bytes, shown once, sealed) and **Test**. Each wanted event is POSTed once as JSON with ids and labels only (never output, a command or a note's text), with `X-Runbooks-Event` and `X-Runbooks-Signature: t=<unix>,v1=<HMAC-SHA256 of "<t>.<body>">`. Retries after 1, 5, 30 and 120 minutes, then it is given up. See [docs/notifications.md](docs/notifications.md), with a receiver that checks the signature.
- Amendments. `POST /agent/steps/{id}/amend` (MCP `amend_step`): `{ kind: "replace" | "substep", reason, step }`. A fixed version (`replace`) of a step that did not end done, or an extra step (`substep`) after a step in any state, goes right after it as **3a**, **3b**: the new step keeps the step's position with a letter (`suffix`), and later steps keep their numbers. A replaced step gets status `replaced`, folds to "Replaced by 3a" with its runs, counts as ended and does not run, take a mark or a skip. The new step says "Amended by <token name>: <reason>" (reason up to 500 characters), and a fixed version shows the old command struck through. An amendment can be amended. Refused with 409 `closed`, `running`, `done` (replace on a done step) and `replaced`, and checked like a new step. A step's output hidden from agents stays hidden in its fixed version. Steps have `label`, `suffix`, `amendment` and `replacedBy`; the runbook list says "amended" while an amendment has not run (`amendedPending`).
- Steps run outside Termix. A person step may have `command` and `where` (up to 80 characters, such as "Windows PC, PowerShell as admin") and no `hostId`. It shows "Run outside Termix: <where>", the resolved command and Copy (off while a value is missing), and no Run or Send to terminal (409 `outside`). The person pastes the output and marks it Done or Failed (`POST /steps/{id}/manual` with `output` and `revision`); checks and captures read the pasted output, and the run has `mode: "outside"`. `where` without a command, with a host, `stdin`, `secretCaptures` or `exitCode` checks is refused (400). Agent API, MCP and amendments take `where`.
- A Copy button on every fenced code block in a step's text and its "You should see" text.
- `stdin` names an amendment as `"3a"`; numbers still name steps.
- Event `amended` (reason `replace` or `substep`, `stepId` the new step), delivered only when `notify` lists it. Events and webhook requests carry `stepLabel` besides `stepPosition`.
- **Send to agent** on every step when notifications are on and the runbook has an owner: "Send step N to <agent>?" with an optional note of up to 500 characters. It records a `sent` event, always delivered, says "Sent to <agent>", and shows in the step's history.

### Changed

- `POST /agent/steps/{id}/complete` now exists: for a person's step it answers 403 instead of 404.
- A step with a command and no host is refused with "a step with a command needs a hostId, or where for a command the person runs outside Termix".
- Reopen of a replaced step works only when its fixed version was skipped and never ran; otherwise 409 `replaced`.
- With amendments, `position` in add steps and `reorder` count steps, not amendments: an amendment moves with its step. A step with amendments, and a fixed version, cannot be removed.
- An order refusal's `blocking` and a wait's `previous` also carry the step's `label`.

## 1.2.0

### Added

- Standard input for a step. Agents set `stdin` on a step: the standard output or standard error of an earlier step's latest finished run (`{ "from": "step", "step": 2, "stream": "stdout" }`, with `allowFailed` to take a failed run's output), a value (`{ "from": "value", "name": "build_id" }`, with one newline), or a secret (`{ "from": "secret", "name": "api_token" }` captured earlier in the runbook, or `{ "from": "secret", "library": "shared/<name>" }` and `mine/<name>` from the OpenBao Secrets library, read as the person who runs it). Run writes it to the command's standard input and ends it; at most 256 KB. The step and the Run confirm say where it comes from ("Standard input: output of step 3 (stdout, 1.2 KB)"), with the first 200 characters of a step or value input and never a secret. The approved hash covers the source. Send to terminal is off for such a step. A Run is refused with 409 `stdin-missing` while the input is not there yet.
- Secret captures. Agents set `secretCaptures` on a step (at most 10, the same pattern rules as captures). When its run, or a terminal Mark done, ends done, each match is stored in OpenBao through the OpenBao Secrets plugin, in Runbooks' own area, for 7 days; a pattern that matches nothing fails the step with "secret <name>: no match". A later step reads it as standard input. Secrets never appear in commands.
- Secret values a step captures or reads are replaced by `[secret:<name>]` in its standard output, standard error, pasted output and captured values before anything is stored or shown, also when a value is split across two pieces of live output. The output of a step that captures a secret shows when its run ends.
- A runbook's secrets are deleted when a person marks it done or abandoned, or on the next read by a person after an agent closed it; the rest expire after 7 days.
- Agents read secrets as `{ name, step, set, expiresAt }` on the runbook, and each run's `stdin` (source and size) and `secrets` (names read and stored), in the agent API and MCP. The MCP tools explain `stdin` and `secretCaptures` with an example.
- The OpenBao Secrets service (`openbao-secrets.store` `^1.0.0`) is an optional requirement. Without it, steps that use secrets are refused with "Install and connect the OpenBao Secrets plugin to use secrets"; people who run them need its Use secrets permission.
- Done and Failed buttons for a step with no command, the size of Run. A click records a run in mode `manual` with who, when, the outcome and the step's note; agents see it like other runs.
- Runs keep `startedEarlySeconds` when a person started before the step's wait timer ended; the run history shows "started 36 s early" and agents see the field.

### Changed

- Skip is a separate small button on every pending step, always labelled Skip. "Mark read" is gone: use Done.
- Mark done on a terminal run needs at least one line of pasted output; the server refuses an empty paste with 400.
- An early start on a wait timer asks one question, "The wait is not over: m:ss left (reason)", with the command, Cancel focused and Start anyway as a warning, instead of a Run confirm and then a second question.

## 1.1.0

### Added

- Live output. Run answers at once and the command goes on in the background. While it runs, the step shows its standard output and standard error as they arrive, how long it has run, and how long since it last printed anything, which turns to a warning after 30 seconds without output. The page reads it every second while a command of the open runbook runs.
- Stop on a running step, after a confirm. It sends the command a TERM signal where the server takes one and closes its session; the run ends failed with "stopped by" and the person, and is audited. Agents and Termix API keys cannot stop a run.
- Agents read a running run's output so far: `running: true`, `stdout` and `stderr` up to now, and `lastOutputAt`, in the agent API and MCP `get_runbook`. Hidden steps still read `[hidden by owner]`.
- Checks on a step's output. Agents set `checks` on a step: `exitCode`, `contains` and `notContains`, `matches` and `notMatches` (on stdout, stderr or either), and `value` (a value the step captures). Runbooks tests them when a run ends, and on the pasted output when a terminal run is marked done. A failed check marks the step failed even on exit code 0; the step lists its checks with a tick or a cross and a reason, and the Run confirm shows them. Runs carry the results as `checks` in the agent API and MCP.
- An optional exit code box next to Mark done for a terminal run.
- Wait timers. Agents set `waitAfterPreviousSeconds` (1 to 86400) and an optional `waitReason` on a step. Once the step before it ends, the step counts down ("Wait 1:42 before you start") and Run and Send to terminal look not-yet; starting before the end asks "Start anyway?" and is audited. The server refuses an early start with 409 `wait` until confirmed. Agents read `waitUntil` on a step while its timer runs.
- Output of a running command is saved every 2 seconds. A run that was running when Termix restarted ends failed with "interrupted: Termix restarted while it ran" and keeps the output saved so far.

### Fixed

- A character split across two pieces of command output (such as an accented letter or a box-drawing line) no longer shows as broken characters.

## 1.0.1

### Added

- Links that open a runbook: `<Termix address>/?view=runbook&id=<id>` opens the Runbooks tab on that runbook, after a sign-in when the person was signed out. Every runbook in the agent API and MCP answers carries its `openPath`, and the MCP tools tell agents to give the person that link.

### Fixed

- Send to terminal takes one click. With no terminal open to the step's host, it opens one, waits for it to connect and types the command in, instead of only opening it. The "Send to ...?" question is gone: the command is typed without Enter, so nothing runs until you press Enter there. The repeat and order questions stay.
- Send to terminal finds an open terminal when the terminal and Termix give the host id in different forms (text or number), prefers the one on screen, and brings it to the front.
- When a new terminal does not connect within 30 seconds, no run is recorded and Runbooks says to copy the command instead.
- Remote desktop hosts (RDP, VNC, consoles) are no longer offered for agent tokens. Runbooks runs and types commands over SSH only, so token hosts, agent steps, Run and Send to terminal now refuse a host that does not take SSH.
- A 1.0.0 token that lists a remote desktop host stops offering it to agents once someone with Manage Runbooks tokens opens Agent tokens.

## 1.0.0

### Added

- Runbooks, steps, runs and agent tokens, with migrations for SQLite, PostgreSQL and MySQL
- An agent API under /plugin-api/runbooks/agent/ and an MCP endpoint, both behind Runbooks tokens; agents propose and read, never run
- Agent tokens limited to the hosts chosen for each token
- Runs over SSH or through an open terminal, with checks for a changed step, step order, repeats and a stored host key
- Values with {{name}} placeholders, filled by the author or captured from output
- Output hidden from agents per step
- A Runbooks tab with the runbook list, step cards, run history, notes and token management
