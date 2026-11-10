---
title: FAQ and limits
order: 3
---

# FAQ and limits

## Can the agent run a command if I give it a Termix API key?

No. Every route that runs or approves something refuses Termix API keys. Only a person signed in to Termix can run a step.

## Who sees which runbooks?

Everyone with the Use Runbooks permission sees every runbook and its output. An agent token sees only runbooks made with tokens of the person who made it.

## Which hosts can an agent use?

Only the hosts ticked for its token. Change them with **Hosts** on the token's row in Agent tokens. A host that is removed from Termix stays in a token's list until you change it, but a step on it cannot run.

## Why is my remote desktop host not in the list?

Runbooks runs and types commands over SSH, so only hosts with SSH switched on can be ticked for a token. A remote desktop host (RDP, VNC, a console) is left out, and a step on one is refused. A host that has both SSH and remote desktop switched on is an SSH host. A token made with 1.0.0 that lists a remote desktop host shows it as "not SSH" in Agent tokens, and agents no longer get it.

## Why does the agent get "not a host this token may use"?

The step names a host that is not ticked for the token. Tick it on the token, or ask the agent to call `list_hosts` and pick one from the list.

## Why is Run refused with "open a Terminal to this host once"?

Termix has no stored host key for that host, and a connection with nobody to ask would accept any key. Open a terminal to the host, check and accept its key, then run the step again.

## The agent changed a step while I was reading it

The run is refused and the page reloads with the new command. Read it again before you run it.

## Does Send to terminal run the command?

No. One click finds a connected terminal to the step's host, or opens one and waits for it to connect, then types the command without pressing Enter. You read it there and press Enter yourself. That is why it asks no "are you sure" question; it still asks before a repeat or a step out of order.

## How do I see if a command stalled?

Watch the running step. Its output shows as it arrives, with **Running for m:ss** and **No output for Ns**. After 30 seconds without output the silence turns to a warning. Some commands are quiet while they work (a large download, a database dump to a file), so a warning is a hint, not proof. If it is stuck, press **Stop**. A command that waits for input, such as a password or a yes/no question, never gets an answer from Run: stop it and use Send to terminal, or change the command so it does not ask (for example `apt-get -y`).

## What does Stop do?

It sends the command a TERM signal, where the SSH server accepts signals, and closes the command's session. Many servers ignore signals for a command without a terminal, and some programs keep running after their session closes. Check the host if it matters. The run is kept as Failed with "stopped by" and your user, and the output so far. Agents and Termix API keys cannot stop a run.

## Send to terminal says it could not send

Send to terminal uses the SSH Terminal plugin. Make sure it is on. If a new terminal does not connect within 30 seconds, Runbooks stops waiting and records nothing. You can always copy the command instead.

## Why is Send to terminal off for this step?

The step gets its standard input from an earlier step, a value or a secret, and only **Run** can give a command its standard input. Use **Run**.

## A step says "Install and connect the OpenBao Secrets plugin to use secrets"

The step captures or reads a secret, and Runbooks keeps secrets only in OpenBao, through the OpenBao Secrets plugin. Install it, connect it to OpenBao, and give the people who run such steps its **Use secrets** permission. Steps without secrets work without it.

## Where are captured secrets, and for how long?

In OpenBao, in Runbooks' own area of the OpenBao Secrets plugin, for 7 days. They are deleted when the runbook is marked done or abandoned. Runbooks never stores them itself, never shows them, and agents never get them. See [Security](security.md#secrets).

## Why does the output say [secret:api_token]?

That is where a secret's value was. Runbooks replaces every secret a step captured or read, in all its output, before it keeps or shows it.

## Why is there no output while a step runs?

The step captures a secret. Its value is known only when the output is complete, so the output shows when the run ends, with the secret replaced.

## Why is Mark done greyed out?

Paste the terminal output first: Mark done needs at least one line of it. If there is nothing to paste, use **Mark failed**, or Skip the step.

## Why is Done greyed out on a step run outside Termix?

The step has checks, and they read the output you paste. Paste at least one line of it first (1.4.1). If there is nothing to paste, press **Failed**, or Skip the step.

## How do I change the step colors?

In **Settings**, **Runbooks**: an admin sets **Step colors** for everyone, and each person can set **Your step colors** for themselves. Use `#rgb` or `#rrggbb`, or leave a color empty for the built-in one.

## How do I finish a step with no command?

Press **Done** or **Failed**. The note in the step's Notes box goes with it. **Skip** is there too, for a step you do not do.

## Why can't I run a step that says "Waiting for the agent"?

It is an agent step: work the agent does itself, outside Termix. Termix never runs it, so it has no Run, Send to terminal or Done. The agent ends it when every step before it has ended. If you did the work yourself, **Skip** it with a reason. If the agent got it wrong, **Reopen** it and the agent can end it again.

## Why is there no Send to agent button?

It shows only when an admin has turned on agent notifications ([Agent notifications](notifications.md)) and the runbook says which agent it belongs to (its owner). Ask the agent to set its owner, or ask an admin to turn notifications on.

## Does Send to agent send the output to the agent?

No. The notification says only which runbook and step, and that there is a note. The agent reads the step, its output and your note with its own token, so output you hid from agents stays hidden.

## Why does this step have no Run button?

It says "Run outside Termix": its command runs somewhere Termix cannot reach, such as a Windows PC. Copy it, run it there, paste the output and mark the step Done or Failed.

## What is step 3a?

An agent amended step 3: 3a is a fixed version of it (step 3 then says "Replaced by 3a") or an extra step after it. The agent's reason is on the step. Later steps keep their numbers. See [Amended steps](index.md#amended-steps).

## Why can't I reopen a replaced step?

Its fixed version is live. Skip the fixed version first, then reopen the replaced step. Once the fixed version ran, the replaced step stays replaced: ask the agent to amend the fixed version instead.

## Limits

- Output: at most 256 KB of standard output and of standard error is kept per run; a run that went over is marked "Output cut".
- Time: 120 seconds per command by default, 600 seconds at most.
- Live output: the page reads it every second while a command runs; Termix saves it to the database every 2 seconds, so a restart can lose the last 2 seconds of it.
- Captures read the first 256 KB of output and stop after 250 ms each; so do secret captures, at most 10 per step.
- Standard input: at most 256 KB.
- Captured secrets expire after 7 days.
- Jump hosts: the host key check covers the target host. Termix stores a jump host's key on first use without asking.
- The hash that binds a run to what you saw covers the host id and the command, not the host's address or login. A host edited in Termix between loading the page and running still runs the shown command on the edited host.
- Rate limits are kept in memory and reset when Termix restarts.
- MCP: JSON answers only, no event stream or sessions.
- Agent steps: a note of up to 2000 characters and output of up to 64 KB. Send to agent: a note of up to 500 characters.
- Notifications: 10 seconds per request; retries after 1, 5, 30 and 120 minutes, then given up.
- The endpoint list in Agent tokens uses the browser's address and does not add a base path.
