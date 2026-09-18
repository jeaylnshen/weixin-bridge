# Weixin Agent Bridge Server 0.3.3

The Server is the only component that logs in to Weixin. It routes each user to
its local executor or a registered remote Client.

## Requirements

- Node.js 22+
- One supported local CLI: Codex, Claude, OpenCode, Google Antigravity (`agy`), or CodeBuddy (`codebuddy`)

## Configure and run

```bash
node weixin-agent-bridge.mjs login
export WEIXIN_SERVER_HOST=0.0.0.0
export WEIXIN_SERVER_PORT=8787
export WEIXIN_AGENT_TYPE=codex
export WEIXIN_AGENT_CWD=/srv/project
node weixin-agent-bridge.mjs server
```

The generated Server secret defaults to
`~/.codex/weixin-agent-bridge/server/server.secret`. Transfer it securely to
Clients. Set `WEIXIN_ALLOWED_CLIENT_HOSTS` when registrations cross an
untrusted network.

Set `WEIXIN_AGENT_TYPE` explicitly to `codex`, `claude`, `opencode`, `agy`, or `codebuddy`.
Automatic probing is only a fallback. Run `node weixin-agent-bridge.mjs
executor` to inspect the selected executor.

Weixin routing commands are `/agents`, `/agent <client-id>`, and `/agent
status`. Registered Clients report their executor type, which is shown in the
agent list and authenticated metrics.

## systemd

Edit `weixin-agent-bridge-server.service.example`, install it as
`/etc/systemd/system/weixin-agent-bridge-server.service`, then run `systemctl
daemon-reload` and `systemctl enable --now weixin-agent-bridge-server`.
