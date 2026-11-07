---
title: Security
order: 2
---

# Security

Runbooks exists so that an agent can prepare work on your servers without being able to do it. This page says how that is enforced.

## Agents propose, people run

- The agent routes (`/plugin-api/runbooks/agent/...`) can list hosts, write runbooks and steps, change steps that have not run, and read. There is no agent route that runs, sends, completes, skips or reopens a step, or writes a note.
- Those actions are person routes (`/plugin-api/runbooks/...`). Termix checks the login, the route checks the Use Runbooks permission, and a request without a signed-in user is refused.
- A request made with a Termix API key (`tmx_...`) is refused on every route that acts: running, sending to a terminal, marking a run done or failed, skipping, reopening, notes, hiding output, runbook status and tokens. Reading is allowed. Approving a command takes a person in the Termix UI.

## Tokens

- The agent routes are declared public to Termix, so Termix does no login check for them; it records the declaration in its audit log and logs each request. Runbooks then requires `Authorization: Bearer rbk_...` on every request.
- A token is 32 random bytes. Only its SHA-256 is stored. A check compares the hash against every live token in constant time.
- Revoked tokens are refused. A token stops working when its creator loses the Use Runbooks permission.
- Each token may make 120 requests a minute; Termix also limits each address on the public routes.
- A token may name only the hosts ticked for it. The person making or editing the token picks them from the SSH hosts they see, and each one is checked for their connect access and for SSH being switched on. The token keeps a copy of each host's id, name, address and folder and that it takes SSH, nothing else. The token sees only runbooks made with its creator's tokens.
- The host list limits what an agent may propose. Running is separate: the person who runs a step needs connect access to its host at that moment.

## What runs is what you saw

- The page shows each step's resolved command and a hash of the host id and that command. Running sends back the step's revision and that hash. If the agent changed the step, or a value changed, the hashes differ and the run is refused.
- **Run** runs a step only after a confirm that shows the host and the exact command.
- **Send to terminal** asks no such question: it types the command into a terminal to the step's host without pressing Enter, so nothing runs until the person reads it there and presses Enter. The run is recorded only once that terminal is connected.
- Run and Send to terminal refuse a host that does not take SSH.
- A repeat (the step ran before, or the same command ran on the same host in the last 24 hours) and a run out of order each need their own confirm.
- A step that has run cannot be changed or removed by the agent, and nothing can be inserted before it. Runs are never deleted.

## Host keys

When Termix connects to a host with no person to ask and the host has no stored host key, it accepts whatever key the server shows. So **Run** first reads the host and refuses one without a stored key fingerprint, with "open a Terminal to this host once to store its host key". **Send to terminal** is not refused: the terminal asks you about the key itself.

## Hidden output

For a step marked hidden, agents get `[hidden by owner]` instead of its standard output, standard error, pasted output and captured values. Captured values of four characters or more are also masked where they appear in later commands that agents read. An agent can mark a step hidden but cannot clear the mark.

## Markdown

Text from agents renders as Markdown without raw HTML and without images. Links open in a new tab without a referrer.

## Audit

Runbooks writes an audit line for each run, each send to a terminal, each completion, each skip, and each token made, changed or revoked. Termix also records each SSH command and each host lookup.

## Capabilities

| Capability        | Why                                                                         |
| ----------------- | --------------------------------------------------------------------------- |
| `db:own`          | The runbooks, steps, runs and tokens tables                                 |
| `network:serve`   | The routes under `/plugin-api/runbooks/`                                    |
| `ui:surface`      | The Runbooks tab                                                            |
| `hosts:read`      | Host names, the hosts offered for a token, and access checks                |
| `ssh:connect`     | Run a step over SSH, and read whether a host takes SSH and has a stored key |
| `credentials:use` | Use the host's stored login for that run                                    |
