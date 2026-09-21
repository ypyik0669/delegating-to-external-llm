---
description: Open the local lane dashboard with live progress and seven-day history
---

Run this command using a background Bash call so a newly started server can stay running:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/lane-dashboard.mjs" --open
```

Relay its `DASHBOARD:` URL verbatim. If a dashboard already owns the port, the command opens it and exits successfully. Preserve the lane's status directory by adding `--dir "<returned-status-directory>"` when supplied; otherwise the normal status-directory environment applies. The port follows `LLM_DASHBOARD_PORT` (default 7788). A manual launch works even with auto-start disabled via `LLM_DASHBOARD=0`.
