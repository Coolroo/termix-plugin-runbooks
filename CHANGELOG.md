# Changelog

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
