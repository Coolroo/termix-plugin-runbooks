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

## Send to terminal says it could not send

Send to terminal uses the SSH Terminal plugin. Make sure it is on. If a new terminal does not connect within 30 seconds, Runbooks stops waiting and records nothing. You can always copy the command instead.

## Limits

- Output: at most 256 KB of standard output and of standard error is kept per run; a run that went over is marked "Output cut".
- Time: 120 seconds per command by default, 600 seconds at most.
- Captures read the first 256 KB of output and stop after 250 ms each.
- Jump hosts: the host key check covers the target host. Termix stores a jump host's key on first use without asking.
- The hash that binds a run to what you saw covers the host id and the command, not the host's address or login. A host edited in Termix between loading the page and running still runs the shown command on the edited host.
- Rate limits are kept in memory and reset when Termix restarts.
- MCP: JSON answers only, no event stream or sessions.
- The endpoint list in Agent tokens uses the browser's address and does not add a base path.
