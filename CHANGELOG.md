# Changelog

## 1.4.5

### Fixed

- The MCP tool schemas told agents a library secret path the server refuses (`mine/a/b/c/d/e`, or one with an empty part). Their library, app field and name patterns now come from the regular expressions the server checks with, and a test keeps them equal.
- The agent API refuses a body that is not an object with 400 "body must be an object" when it creates or changes a runbook, adds steps or reorders them. An array was taken as an empty body before, and adding or reordering steps with no body said only that steps or stepIds were missing.
- The wait timer of a Make a secret or Ask for a secret step had no test. A test now checks that an early Make it gets the 409 `wait` answer, and that `waitAnyway` makes the secret.
- Copy in the boxes that show a new agent token or the notification signing secret once says "Copied" after a copy, as every other Copy button does.
- A refused **Mark done** with pasted output, or a refused note save, reads the runbook again, as a refused **Stop** already did, so the page does not show a step that changed meanwhile.
- The agent tokens page shows the server's error text only when it is text, and its general message otherwise, instead of turning any error value into text.
- "Stored until" on a secret step uses the same time format as the rest of the page; a value that is not a date shows as it was sent instead of "Invalid Date".

### Changed

- The release and CI workflows follow the current Termix plugin template: write permissions only on the release job, only the two secrets it uses (`TERMIX_PAT`, `TERMIX_PLUGIN_SIGNING_KEY`) instead of every secret, and no `overwrite` mode. Dependabot updates npm packages (not the plugin SDK) and the pinned actions weekly.
- The frontend tests share `tests/frontend/helpers.tsx`: the rendered app, typed builders for what the server sends (`makeSummary`, `makeStep`, `clickStep`, `makeRun`, `makeRunbook`), a fake of the routes (`fakeApi`), `openRunbook`, `card` and `flush`. Their fixtures now match the server: a wait names the previous step's `label`, the fake `GET /runbooks` sends the list fields only, and `GET /colors` sends no colors.
- The backend tests share `useTestServer`, `setupRunbook` and `execResult` from `tests/backend/helpers.ts`, instead of a copy of each in every file.
- The tests of `src/shared` code (values in text, SSH hosts, step numbers) moved to `tests/backend/shared/`.
- `{{name}}` in a command is filled by `fillPlain` in `src/shared/fill.ts`, the filler of a step's `where`, instead of a copy in `src/backend/values.ts`. A new test pins the resolved text and hash of a set of commands, and they did not change. The agent view's `missing` comes from the same fill instead of a second scan of the command.
- The rules on names live in `src/shared/names.ts`: the value and secret name (`NAME`, which was `VALUE_NAME` and `SECRET_NAME`), `{{name}}` (`PLACEHOLDER`), `MAX_SECRET_NAME`, `LIBRARY_REF`, `secretNameProblem`, `regexProblem` (the check on a capture, check or ask pattern) and `isOneLine`. The server's checks, the MCP schemas and the page's store line use them instead of their own copies; every error message is the same.
- A step's `body`, `expect` and `where` are filled by one function, `fillStepText` in `src/shared/fill.ts`: the server's `resolvedBody`, `resolvedExpect`, `resolvedWhere` and `textMissing` come from it, and the page uses it with its "not set yet" marker instead of its own copy. The API sends the same fields as before.
- What the person routes send is typed once, in `src/shared/api.ts`: runbooks, steps, runs, waits, inputs, secret states, amendments, progress, tokens and the 409 answers the page asks about (`ConflictBody`). The server's view builders (`personView`, `runbookSummary`, `amendmentView`, `progress`, `runSummary`, the runbook list) return these types, and `src/frontend/api-types.ts` re-exports them instead of a hand copy, so the server and the page type-check against one definition. Fields the server always sends are required, and the page no longer falls back from `agentLabel` to `createdBy` or from a step's `label` to its position. `Translate` has one definition.
- Small rules have one definition each. The page numbers steps and matches a step's secrets with `stepLabel` and `stepRef` from `src/shared/steps.ts`, as the server does. `isAgentStep` and `isOutsideStep` there tell the step kinds, the step card, the person view and the routes which steps Termix never runs. `MAX_SENT_NOTE` lives in `src/shared/limits.ts`, and `secretLabel` (the name of the secret a step's input reads) in `src/shared/names.ts`.
- One module (`gates.ts`) decides whether a step may be acted on: an agent step, a closed runbook, a replaced step, a stale page, missing values, the order and the wait timer. Run, Send to terminal, Done and Failed, secret steps and an agent's completion all use it, each asking in its own order. Send to terminal no longer asks about an agent step twice.
- `events.endStep` ends a step everywhere, including the sweep at start-up. `judgeOutput` finds secrets, hides them, takes captures and only then runs checks, so checks still never see a secret.
- `insertRun` fills in the fields that an unfinished or hand-ended run does not have. `events.changeRunbook`, `secrets.read`, `storedRun`, the audit helpers and one `APP_STORE_NEEDS` replace copies that were in two or three places.
- `http.ts` (wrap, idParam, body, requireSignedIn, refuseApiKey) and `parse.ts` (InputError, strictObject, optionalText, parseOutcome) are shared by the person, agent and admin routes. Each keeps its own wording.
- The store reads rows by id, nullable columns, query conditions and JSON patches through one helper each.
- The page's text helpers (times, durations, sizes, waits, the input source, the host label, the run summary) live in `format.ts`, and its clocks (`useTick`, `useFetchedAt`, `useWaitRemaining`, `usePolling`) in `timers.ts`.
- Run, Send to terminal and Make it or Save share one handler for the repeat, wait, order and stale answers, and every step and runbook action posts through `postRunbook` or `postThenLoad`. The in-pane prompts use `usePromptRequest` and `usePaneEscape`, and finding or opening a terminal is `openSessionFor` in `terminal.ts`.
- Shared screen pieces live in `ui.tsx`: `SectionLabel`, `CodeBlock`, `CommandBlock`, `OutcomeButtons`, `PasteFirstHint`, `ShownOnce`, `RunbookStatusBadge`, `runbookMeta` and `LoadError`.
- A step's kind, marks, color and state are worked out once per render, and the cards, the rail and the bar all use that one result.
- New tests pin the refusals of every route and the 200-step limit, `judgeOutput`, the page's order and stale answers, and Skip, Reopen, Hide, Note and the runbook status buttons.
- The code is in one folder per feature (`core`, `runbooks`, `values`, `running`, `checks`, `secrets`, `kinds`, `agents` on the server; `ui`, `runbooks`, `steps`, `running`, `secrets`, `kinds`, `nav`, `agents` on the page), and the large files are split: `service.ts`, the store, the MCP server, the person routes (one kit with the one set of running steps), the agent operations, the step card and the Runbooks tab. The routes, their guards and their order, the MCP tools, settings, permissions and tables are the same; `dist/openapi.json` lists the same paths in a new order. Bar items are registered in `src/frontend/nav/bar-items.tsx`.
- Dead code is gone: `store.getEvent`, the server's re-export of `describeCheck`, two unread terminal session fields, and the `export` on constants and functions that only their own file uses.

## 1.4.4

### Added

- A bar under the open runbook names the next step: its number of the total, how many are done, its title and its kind. **Go to step** puts that step in the middle of the view and moves the focus to it. The key **N** does the same while the focus is in the runbook, never while you type in a field, and never in a terminal. When the step is already on screen, the bar says "On screen" and the button goes quiet. When the next step failed, it says "Failed" in red. With every step done, or the runbook closed, it says so, and **Go to top** goes back to the runbook's own buttons.
- A rail of steps on the right edge of the runbook. It shows only the steps near the part of the runbook on screen, at most 11, so a runbook of 80 steps stays readable. Each step is a dot drawn like its card: the next step big and glowing, pending steps a ring, done ones a dimmed dot, failed ones red, replaced and skipped ones grey. A box marks the steps on screen, and counts above and below say how many steps the rail leaves out (click one to move by a window). When the next step is outside the window, its number stays pinned at the rail's edge. Hover or focus on a dot to see its number and title, and click it to go there.
- In a narrow pane (under 560 px, as on a phone) the rail hides, and the bar shows a progress strip with the next step and the steps on screen.
- The bar's contents come from one registry, `src/frontend/bar-items.tsx`. A new button is one entry (`registerBarItem` with an id, an order, a label and an onClick, plus an optional icon, key and `when`); anything else is a custom entry that renders itself. The bar draws every entry from it, and the keys of its buttons work from it, so Go to step and N are entries like any other. The README's "Adding a button to the bar" shows how.

### Changed

- A runbook scrolls in its own area between the panel's header and the new bar, beside the rail. Step cards can take the focus (`tabIndex=-1`), so the bar and the key can move it there.

## 1.4.3

### Fixed

- `{{name}}` values fill a step's text, not only its command. `body`, `expect` and `where` showed the bare name, so a click step that said "find `{{ts_ip}}` in the admin console" gave the person no address. They now get the same values as the command (the author's, then captures), on the server, as `resolvedBody`, `resolvedExpect` and `resolvedWhere` (null when the step has no `where`), with `textMissing` for names that have no value yet. The person view, the agent API and MCP `get_runbook` return them next to the written text. In an agent's view, a value from a step hidden from agents shows as `[hidden by owner]`, as in `effectiveValues`.
- A value is never Markdown. Outside code, its Markdown characters are escaped with a backslash, its line breaks become spaces, and a bare address in it (`://`, `www.`, `@`) gets an empty HTML comment that the page drops, so a value cannot add a link, an image, a heading, emphasis or HTML. Inside a code span or a code block it goes in as it is: a value with backticks gets a longer code span, and a value with a fence line gets a longer fence. In the author's link destination (`[text]({{url}})`) and autolink (`<https://{{host}}/>`) it makes the link the author wrote. `where` is plain text, filled as it is.
- A value not set yet shows as "(value ts_ip: not set yet)", and the step's "Values missing" line names it. It does not stop the step: a click step can still be marked done or failed, and a command runs when the command's own values are set, as before.
- A Copy button on a code block in `body` or `expect` copies the filled-in text.

## 1.4.2

### Added

- **Make a secret** steps. A step with `generate: { name, format, length, store }` makes a new random value on the server when a person clicks **Make it**: `alnum` (letters and digits, the default, 16 to 128, default 32), `hex` (16 to 128, default 64), `base64url` (16 to 128, default 43), `words` (4 to 12 words of the EFF long word list joined by `-`, default 6) or `pin` (4 to 12 digits, default 6). Each character or word is picked with `crypto.randomInt`, so there is no modulo bias. The step says "Make secret <name>: 32 letters and digits" and where the value goes.
- **Ask for a secret** steps. A step with `ask: { name, label, pattern?, store }` takes a value the person types or pastes once, such as a token another site shows, in a field that shows it while it is typed with **Hide** (as in OpenBao Secrets 1.0.2), then **Save**. The value is trimmed and must match `pattern` whole (checked with a time limit); a refusal never repeats it.
- Where the value goes, `store`: `"runbook"` (the default: the runbook's own secrets, as captured ones, for 7 days and deleted when the runbook ends), `{ library: "mine/<path>" | "shared/<path>", expires?: <days, 1 to 30> }` (a new secret in the OpenBao Secrets library, never replacing one: 409 `exists`), or `{ app: "<app>/<host>", field }` (a new field through OpenBao Secrets 1.0.5's `createAppField`, for app paths its admin allows; 409 `app-store-off`, `app-not-allowed` or `exists` when it refuses).
- The value never reaches the browser, an agent, an event, a notification, the audit log or any output. The run (`mode: "secret"`) says "Made secret <name>" or "Saved secret <name>" with `secrets.made` (`name`, `how`, `store`, `where`, `expiresAt`). Later steps read it with `stdin: { from: "secret", name }` (or the library form), and every later output of the runbook shows `[secret:<name>]` instead of it, also in steps that do not read it.
- By hand: when OpenBao Secrets is not installed or not connected, or an app path store meets an OpenBao Secrets without `createAppField`, the step shows **Do it by hand**: for Make a secret the format and length to make in a password manager, then the KV engine, path and field to save it at in OpenBao or Vault (each with Copy), and **Done** and **Failed**. A later step that reads the secret says where to get it.
- `POST /plugin-api/runbooks/steps/{id}/secret` (`{ revision, value?, confirmRepeat?, outOfOrder?, waitAnyway? }`), a person only, asks about a repeat, the order and a wait as Run does. Agents can set `generate` and `ask` (REST, MCP, amendments) but never make, save or complete such a step; `owner: "agent"`, a command, a host, `where`, `stdin`, captures, secret captures and checks are refused on it (400), as are bad formats, lengths, names, labels, patterns and stores.
- Two step kinds in the registry: **Make a secret** (fuchsia, Dices) and **Ask for a secret** (teal, Clipboard paste), with their own color settings.
- The EFF long word list (CC BY 3.0 US), credited in NOTICE and the README.

### Changed

- A step that reads a secret by name may read one an earlier step made or asked for with store `"runbook"`. Reading a library or app store secret by name is refused with a hint to use the library form.

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
