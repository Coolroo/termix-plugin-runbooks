---
title: FAQ and limits
order: 3
---

# FAQ and limits

## Can the agent run a command if I give it a Termix API key?

No. Every route that runs or approves something refuses Termix API keys. Only a person signed in to Termix can run a step.

## Who sees which runbooks?

Everyone with the Use Runbooks permission sees every runbook and its output. An agent token sees only runbooks made with tokens of the person who made it.

## Why is Run refused with "open a Terminal to this host once"?

Termix has no stored host key for that host, and a connection with nobody to ask would accept any key. Open a terminal to the host, check and accept its key, then run the step again.

## The agent changed a step while I was reading it

The run is refused and the page reloads with the new command. Read it again before you run it.

## Send to terminal says it could not send

Send to terminal uses the SSH Terminal plugin. Make sure it is on and a terminal to that host is open and connected. You can always copy the command instead.

## Limits

- Output: at most 256 KB of standard output and of standard error is kept per run; a run that went over is marked "Output cut".
- Time: 120 seconds per command by default, 600 seconds at most.
- Captures read the first 256 KB of output and stop after 250 ms each.
- Jump hosts: the host key check covers the target host. Termix stores a jump host's key on first use without asking.
- The hash that binds a run to what you saw covers the host id and the command, not the host's address or login. A host edited in Termix between loading the page and running still runs the shown command on the edited host.
- Rate limits are kept in memory and reset when Termix restarts.
- MCP: JSON answers only, no event stream or sessions.
- The endpoint list in Agent tokens uses the browser's address and does not add a base path.
