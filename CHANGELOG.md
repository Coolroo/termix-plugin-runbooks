# Changelog

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
