# Changelog

## 1.0.0

### Added

- Runbooks, steps, runs and agent tokens, with migrations for SQLite, PostgreSQL and MySQL
- An agent API under /plugin-api/runbooks/agent/ and an MCP endpoint, both behind Runbooks tokens; agents propose and read, never run
- Agent tokens limited to the hosts chosen for each token
- Runs over SSH or through an open terminal, with checks for a changed step, step order, repeats and a stored host key
- Values with {{name}} placeholders, filled by the author or captured from output
- Output hidden from agents per step
- A Runbooks tab with the runbook list, step cards, run history, notes and token management
