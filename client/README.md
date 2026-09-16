# Weixin Agent Bridge Client 0.3.0

The Client runs an AI Agent locally, exposes authenticated `/v1/execute`, and
registers with the central Server. It never logs in to Weixin.

## Requirements

- Node.js 22+
- One supported CLI: Codex, Claude, or OpenCode
- A reachable HTTPS/private-network Client URL

## Configure

```bash
export WEIXIN_SERVER_URL=https://bridge.example.com:8787
export WEIXIN_SERVER_SECRET_FILE=/etc/weixin-agent-bridge/server.secret
export WEIXIN_CLIENT_ID=server1
export WEIXIN_CLIENT_LABEL='Cloud Server 1'
export WEIXIN_CLIENT_HOST=0.0.0.0
export WEIXIN_CLIENT_PORT=8788
export WEIXIN_CLIENT_PUBLIC_URL=https://server1.example.com:8788
export WEIXIN_AGENT_TYPE=codex
export WEIXIN_AGENT_CWD=/srv/project
node weixin-agent-bridge.mjs client
```

Set `WEIXIN_AGENT_TYPE` to `codex`, `claude`, or `opencode`. Explicit selection
always wins. If omitted, the Client probes in that order and warns when more
than one CLI is installed. A custom `WEIXIN_AGENT_BIN` requires an explicit
type. Run `node weixin-agent-bridge.mjs executor` to inspect the selection.

Common settings are `WEIXIN_AGENT_MODEL`, `WEIXIN_AGENT_TIMEOUT_MS`, and
`WEIXIN_AGENT_EXTRA_ARGS`. Existing `WEIXIN_CODEX_*` variables remain
compatible. Execution policy stays local and cannot be overridden by Server
requests.

## systemd

Edit `weixin-agent-bridge-client.service.example`, then install it as
`/etc/systemd/system/weixin-agent-bridge-client.service`. Protect the Server
secret with mode `0600` and do not expose the Client without authentication.
