---
title: Security
order: 2
---

# Security

Runbooks exists so that an agent can prepare work on your servers without being able to do it. This page says how that is enforced.

## Agents propose, people run

- The agent routes (`/plugin-api/runbooks/agent/...`) can list hosts, write runbooks and steps, change steps that have not run, and read. There is no agent route that runs, sends, skips or reopens a step, or writes a note.
- An agent can end only its own steps (`owner: "agent"`), with `POST /agent/steps/{id}/complete`, once every earlier step ended. Termix runs nothing for such a step: Run and Send to terminal refuse it, and its command is only text. A person can skip or reopen it. The completion is audited with the token's name.
- Those actions are person routes (`/plugin-api/runbooks/...`). Termix checks the login, the route checks the Use Runbooks permission, and a request without a signed-in user is refused.
- A request made with a Termix API key (`tmx_...`) is refused on every route that acts: running, stopping, sending to a terminal, marking a run done or failed, skipping, reopening, notes, hiding output, runbook status and tokens. Reading is allowed. Approving a command takes a person in the Termix UI.

## Tokens

- The agent routes are declared public to Termix, so Termix does no login check for them; it records the declaration in its audit log and logs each request. Runbooks then requires `Authorization: Bearer rbk_...` on every request.
- A token is 32 random bytes. Only its SHA-256 is stored. A check compares the hash against every live token in constant time.
- Revoked tokens are refused. A token stops working when its creator loses the Use Runbooks permission.
- Each token may make 120 requests a minute; Termix also limits each address on the public routes.
- A token may name only the hosts ticked for it. The person making or editing the token picks them from the SSH hosts they see, and each one is checked for their connect access and for SSH being switched on. The token keeps a copy of each host's id, name, address and folder and that it takes SSH, nothing else. The token sees only runbooks made with its creator's tokens.
- The host list limits what an agent may propose. Running is separate: the person who runs a step needs connect access to its host at that moment.

## What runs is what you saw

- The page shows each step's resolved command and a hash of the host id, that command and, for a step with standard input, where the input comes from. Running sends back the step's revision and that hash. If the agent changed the step, or a value changed, the hashes differ and the run is refused.
- **Run** runs a step only after a confirm that shows the host and the exact command. The command runs on its own SSH connection, opened through Termix as the person who pressed Run: Termix checks their access to the host, uses its stored login and checks its host key, as for any connection. The request answers at once and the command goes on in the background as that person.
- **Stop** is a person route like Run, refused for agents and Termix API keys, and audited.
- **Send to terminal** asks no such question: it types the command into a terminal to the step's host without pressing Enter, so nothing runs until the person reads it there and presses Enter. The run is recorded only once that terminal is connected.
- Run and Send to terminal refuse a host that does not take SSH.
- A repeat (the step ran before, or the same command ran on the same host in the last 24 hours), a run out of order and a start before a step's wait timer ended each need their own confirm. A start before the wait ended is audited, and the run keeps how many seconds were left.
- A step with no command is marked **Done** or **Failed** by a person only (a person route, refused for agents and Termix API keys), and the run records who and when.
- **Mark done** on a terminal run needs pasted output; the server refuses an empty paste.
- A step that has run cannot be changed or removed by the agent, and nothing can be inserted before it. Runs are never deleted.

## Host keys

When Termix connects to a host with no person to ask and the host has no stored host key, it accepts whatever key the server shows. So **Run** first reads the host and refuses one without a stored key fingerprint, with "open a Terminal to this host once to store its host key". **Send to terminal** is not refused: the terminal asks you about the key itself.

## Hidden output

For a step marked hidden, agents get `[hidden by owner]` instead of its standard output, standard error, pasted output and captured values. Captured values of four characters or more are also masked where they appear in later commands that agents read. An agent can mark a step hidden but cannot clear the mark. Check results stay visible on a hidden step: they say only whether each check the agent wrote passed, never the output, but a check such as `contains` does tell whether the output had that text.

## Secrets

Runbooks keeps no secret of its own. Secrets go through the OpenBao Secrets plugin's service, `openbao-secrets.store`, which Runbooks declares as an optional requirement: without it, steps that capture or read a secret are refused, and nothing falls back to another store.

- **Where they live.** A captured secret is stored in OpenBao, in Runbooks' own area of OpenBao Secrets, at `runbooks/<runbook id>/<name>`, with an expiry 7 days ahead. Runbooks reaches its area with a key that OpenBao Secrets hands to a receiver only Runbooks can register; Runbooks keeps the key in memory and takes one only while its own request for it runs. Library secrets (`mine/`, `shared/`) stay where the person put them.
- **Who.** Every call runs as the person who presses Run or Mark done, and OpenBao Secrets checks their **Use secrets** permission first; a library secret is read with their own access to it. Anyone with Use Runbooks and Use secrets who runs a step of the runbook reaches its captured secrets, as they do its output.
- **Never kept, never shown.** A secret is never written to Runbooks' tables, never sent to the browser, never given to agents, and never part of a command (there is no secret placeholder). The runs table keeps only the names of the secrets a run read or stored, and the source of its standard input with its size.
- **Redaction.** Before any output is stored or shown (the run row, the live output, the API, MCP and the audit log), every secret value a step captured or read is replaced by `[secret:<name>]` in standard output, standard error, pasted output and captured values. Output arrives in pieces, so Runbooks holds back the last characters of each stream (one fewer than the longest value) until more arrives: a value split across two pieces is still replaced. The output of a step that captures a secret is not shown or saved until the run ends, because the value is known only then. Redaction finds the exact text only: a command that prints a secret changed (encoded, split by other text) prints it where it can be read, so write commands that read secrets from standard input and do not print them.
- **Checks.** A step's checks are tested on the output after redaction, and on captured values after redaction (1.4.1). An agent writes checks, so a check on the real value would pass or fail on the secret's characters and tell the agent about them one guess at a time; on the redacted text it cannot.
- **What agents see.** Agents can set `stdin` and `secretCaptures` on steps, and they read each secret as `{ name, step, set, expiresAt }`, never a value. Output with a secret reads `[secret:<name>]` for them too.
- **Deleting.** When a person marks a runbook done or abandoned, Runbooks deletes its area prefix `runbooks/<id>/`. An agent that closes a runbook has no person to act as, so the secrets are deleted the next time a person with Use secrets opens the Runbooks tab. OpenBao Secrets deletes whatever is left when it expires.
- **Audit.** Runs that read or store a secret are audited with the secret's name only ("read secret api_token", "stored secret api_token"), and so is each deletion. OpenBao Secrets audits each call with the area and the name.
- **Made and asked secrets (1.4.2).** A Make a secret step's value is made on the server only when a signed-in person clicks Make it (never for a Termix API key or an agent token), with `crypto.randomInt` for each character or word, so no character is likelier than another. An Ask for a secret step's value comes from the person's browser once, in that request; it is trimmed and checked against the step's pattern in a separate context with a time limit, and a refusal never repeats the value. Either value goes straight to its store through OpenBao Secrets: Runbooks' own area, the person's or the shared library (create only: a secret that is there is never replaced), or an app path through `createAppField` (create only, never read back, only for paths an OpenBao Secrets admin allows and for people with Create app secrets). The answer, the run row, events, notifications and the audit line ("made secret db_password (32 letters and digits) in the runbook's secrets") carry the name, the format and the store, never the value. Every later run of the runbook reads the made and asked values back as the person who runs it (library and runbook stores only) and hides them in its output like a secret it reads; a person without Use secrets gets no such redaction, and the reads add OpenBao Secrets audit lines.
- **By hand.** Without OpenBao Secrets, or while it is not connected, a secret step shows where to keep the value by hand. Runbooks then has no value at all: the person marks the step done, and a later step that reads the secret does not run.

## Agent notifications

Off until an admin turns them on (see [Agent notifications](notifications.md)).

- **Ids and labels only.** A notification carries the event's id, type and reason, the runbook and step ids, the step's position, the runbook's owner as the agent set it, and a link path. Never output, a command, a value or the text of a note. Agents read those through the agent API with their own token, so hidden output stays hidden.
- **Signed.** Each request has an HMAC-SHA256 signature over a timestamp and the body, with a 32-byte secret that Runbooks makes. The secret is shown to the admin once and kept sealed with Termix's installation key in Runbooks' own table, so delivery can sign without a signed-in person. A new secret replaces the old one at once. The secret is never sent to the browser again, never written to the audit log, and never in an error.
- **Where to.** https only: an `http` address is refused when saved and when sent. Requests go through Termix's outbound guard (`ctx.fetch`): the webhook's own host is the only private address allowed, redirects are refused, each request stops after 10 seconds, and the certificate is always checked, against the admin's CA when one is set.
- **Who.** Only an admin (Manage plugins) can see the settings, make a secret or send a test; a Termix API key cannot. Making a secret and each test are audited.
- **What is kept.** Each event's delivery time, its number of attempts, and the last error in short, with the address's query string left out.

## Markdown

Text from agents renders as Markdown without raw HTML and without images. Links open in a new tab without a referrer.

## Audit

Runbooks writes an audit line for each run, each stop, each start before a wait ended, each send to a terminal, each completion, each step marked done or failed by hand, each agent step an agent ended, each skip, each deletion of a runbook's secrets, and each token made, changed or revoked. Secrets are named, never shown. Termix also records each SSH connection and each host lookup.

## Capabilities

| Capability         | Why                                                                         |
| ------------------ | --------------------------------------------------------------------------- |
| `db:own`           | The runbooks, steps, runs and tokens tables                                 |
| `network:serve`    | The routes under `/plugin-api/runbooks/`                                    |
| `ui:surface`       | The Runbooks tab                                                            |
| `hosts:read`       | Host names, the hosts offered for a token, and access checks                |
| `ssh:connect`      | Run a step over SSH, and read whether a host takes SSH and has a stored key |
| `credentials:use`  | Use the host's stored login for that run                                    |
| `network:outbound` | Send agent notifications to the admin's webhook (1.4.0); nothing else       |
| `secrets:own`      | Seal the notification signing secret with Termix's installation key (1.4.0) |

Runbooks also declares the service `openbao-secrets.store` (`^1.0.0`) as an optional requirement, for secrets. It needs no capability of its own.
