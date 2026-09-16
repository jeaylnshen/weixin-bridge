# Deployment Reference

## Server

1. Copy the `server/` directory to the Server machine.
2. Install Node.js 22+ and the selected local Agent CLI.
3. Run `node weixin-agent-bridge.mjs login` and scan the QR code.
4. Set `WEIXIN_SERVER_HOST`, `WEIXIN_SERVER_PORT`, `WEIXIN_CODEX_CWD`,
   `WEIXIN_CODEX_SANDBOX`, and `WEIXIN_CODEX_APPROVAL`.
5. Start `node weixin-agent-bridge.mjs server`.
6. Read the generated secret from `WEIXIN_SERVER_SECRET_FILE`, default
   `~/.codex/weixin-agent-bridge/server/server.secret`.

## Client

1. Copy the `client/` directory to the cloud machine.
2. Install Node.js 22+ and the selected local Agent CLI.
3. Set `WEIXIN_SERVER_HOSTNAME`, `WEIXIN_SERVER_PORT`,
   `WEIXIN_SERVER_SCHEME`, and `WEIXIN_SERVER_SECRET`.
4. Set a unique `WEIXIN_CLIENT_ID`, reachable
   `WEIXIN_CLIENT_PUBLIC_URL`, `WEIXIN_CLIENT_HOST`, and
   `WEIXIN_CLIENT_PORT`.
5. Set `WEIXIN_AGENT_TYPE` explicitly to `codex`, `claude`, or `opencode`, and
   set `WEIXIN_AGENT_CWD` to the project directory. Automatic probing is only
   a fallback when `WEIXIN_AGENT_TYPE` is absent.
6. Start `node weixin-agent-bridge.mjs client`.
7. Confirm the node appears in the Server's Weixin `/agents` output.

The Client can read the Server secret from
`WEIXIN_SERVER_SECRET_FILE` instead of `WEIXIN_SERVER_SECRET`.

## Operations

```bash
curl http://server:port/healthz
curl -H "Authorization: Bearer $WEIXIN_SERVER_SECRET" \
  http://server:port/v1/clients
curl -H "Authorization: Bearer $WEIXIN_SERVER_SECRET" \
  http://server:port/v1/metrics
```

The public health endpoint returns only `{ "ok": true }`, and secrets are not
printed to logs. On Internet-facing Servers, set `WEIXIN_ALLOWED_CLIENT_HOSTS`
to the comma-separated Client hostnames permitted to register.

If a Client disappears from `/agents`, check its heartbeat log, advertised
URL, firewall, reverse proxy, and `WEIXIN_CLIENT_TTL_MS`.
