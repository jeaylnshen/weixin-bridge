#!/usr/bin/env node

import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { createDecipheriv, randomBytes, randomUUID } from "node:crypto";

const VERSION = "0.3.3";
const DEFAULT_BASE_URL = "https://ilinkai.weixin.qq.com";
const DEFAULT_CDN_BASE_URL = "https://novac2c.cdn.weixin.qq.com/c2c";
const DEFAULT_TIMEOUT_MS = 35_000;
const DEFAULT_CODEX_TIMEOUT_MS = 90_000;
const LOGIN_TIMEOUT_MS = 480_000;
const QR_LONG_POLL_TIMEOUT_MS = 35_000;
const DEFAULT_ILINK_BOT_TYPE = "3";
const MEDIA_MAX_BYTES = 100 * 1024 * 1024;
const DEFAULT_AGENT_TIMEOUT_MS = 120_000;
const DEFAULT_AGENT_MAX_UPLOAD_BYTES = 20 * 1024 * 1024;
const DEFAULT_SERVER_PORT = 8787;
const DEFAULT_CLIENT_PORT = 8788;
const DEFAULT_CLIENT_TTL_MS = 90_000;
const MIN_AGENT_TIMEOUT_MS = 1_000;
const MAX_AGENT_TIMEOUT_MS = 15 * 60_000;
const AGENT_TYPES = ["codex", "claude", "opencode", "agy", "codebuddy"];

const state = {
  stopping: false,
  lockDir: "",
  activeChildren: new Map(),
  metrics: {
    httpRequests: 0,
    executeRequests: 0,
    executeSuccesses: 0,
    executeFailures: 0,
    executeTimeouts: 0,
    executeDurationMs: 0,
    registrations: 0,
    heartbeats: 0,
    agentExecutions: {},
    startedAtMs: Date.now(),
  },
};

function log(message) {
  console.log(`[weixin-agent-bridge] ${message}`);
}

function warn(message) {
  console.warn(`[weixin-agent-bridge] ${message}`);
}

function fail(message) {
  console.error(`[weixin-agent-bridge] ${message}`);
  process.exitCode = 1;
}

function resolveOpenClawStateDir() {
  return (
    process.env.WEIXIN_STATE_DIR?.trim() ||
    process.env.OPENCLAW_STATE_DIR?.trim() ||
    process.env.CLAWDBOT_STATE_DIR?.trim() ||
    path.join(os.homedir(), ".openclaw")
  );
}

function weixinStateDir() {
  return path.join(resolveOpenClawStateDir(), "openclaw-weixin");
}

function accountsDir() {
  return path.join(weixinStateDir(), "accounts");
}

function readJson(filePath, fallback = null) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, "utf-8"));
  } catch (error) {
    const backupPath = `${filePath}.bak`;
    try {
      if (!fs.existsSync(backupPath)) throw error;
      const recovered = JSON.parse(fs.readFileSync(backupPath, "utf-8"));
      const corruptPath = `${filePath}.corrupt-${Date.now()}`;
      try {
        fs.renameSync(filePath, corruptPath);
        fs.copyFileSync(backupPath, filePath);
        warn(`recovered JSON from backup file=${filePath} corrupt=${corruptPath}`);
      } catch (restoreError) {
        warn(`read JSON backup without restoring file=${filePath}: ${restoreError.message}`);
      }
      return recovered;
    } catch {
      throw new Error(`cannot read JSON ${filePath}: ${error.message}`);
    }
  }
}

function readText(filePath, fallback = "") {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return fs.readFileSync(filePath, "utf-8");
  } catch {
    return fallback;
  }
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tempPath = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${process.pid}.${randomUUID()}.tmp`);
  const backupPath = `${filePath}.bak`;
  let fd;
  try {
    fd = fs.openSync(tempPath, "wx", 0o600);
    fs.writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`, "utf-8");
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    if (fs.existsSync(filePath)) {
      try {
        JSON.parse(fs.readFileSync(filePath, "utf-8"));
        fs.copyFileSync(filePath, backupPath);
      } catch {}
    }
    fs.renameSync(tempPath, filePath);
    try {
      const dirFd = fs.openSync(path.dirname(filePath), "r");
      fs.fsyncSync(dirFd);
      fs.closeSync(dirFd);
    } catch {}
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch {}
    }
    try { fs.unlinkSync(tempPath); } catch {}
  }
}

function writePrivateJson(filePath, value) {
  writeJson(filePath, value);
  try {
    fs.chmodSync(filePath, 0o600);
  } catch {}
}

function normalizeAccountId(accountId) {
  return String(accountId || "")
    .trim()
    .replace(/@/g, "-")
    .replace(/\./g, "-")
    .replace(/[^a-zA-Z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function readAccountIndex() {
  const parsed = readJson(path.join(weixinStateDir(), "accounts.json"), []);
  return Array.isArray(parsed) ? parsed.filter((id) => typeof id === "string" && id.trim()) : [];
}

function registerAccountId(accountId) {
  const ids = readAccountIndex().filter((id) => id !== accountId);
  ids.push(accountId);
  writeJson(path.join(weixinStateDir(), "accounts.json"), ids);
}

function saveAccount(accountId, update) {
  const filePath = path.join(accountsDir(), `${accountId}.json`);
  const existing = readJson(filePath, {});
  writePrivateJson(filePath, {
    ...(update.token?.trim() || existing.token ? { token: update.token?.trim() || existing.token } : {}),
    savedAt: new Date().toISOString(),
    ...(update.baseUrl?.trim() || existing.baseUrl ? { baseUrl: update.baseUrl?.trim() || existing.baseUrl } : {}),
    ...(update.userId?.trim() || existing.userId ? { userId: update.userId?.trim() || existing.userId } : {}),
  });
  registerAccountId(accountId);
}

function clearStaleAccountsForUserId(currentAccountId, userId) {
  if (!userId) return;
  const remaining = [];
  for (const accountId of readAccountIndex()) {
    const account = loadAccount(accountId);
    if (accountId !== currentAccountId && account?.userId === userId) {
      for (const suffix of [".json", ".codex.sync.json", ".codex.seen.json", ".codex.pending.json"]) {
        try {
          fs.unlinkSync(path.join(accountsDir(), `${accountId}${suffix}`));
        } catch {}
      }
      try {
        fs.rmSync(lockDir(accountId), { recursive: true, force: true });
      } catch {}
      continue;
    }
    remaining.push(accountId);
  }
  writeJson(path.join(weixinStateDir(), "accounts.json"), remaining);
}

function listAccountIds() {
  const configured = process.env.WEIXIN_ACCOUNT_ID?.trim();
  if (configured) return [configured];
  return readAccountIndex();
}

function deriveRawAccountId(accountId) {
  if (accountId.endsWith("-im-bot")) return `${accountId.slice(0, -7)}@im.bot`;
  if (accountId.endsWith("-im-wechat")) return `${accountId.slice(0, -10)}@im.wechat`;
  return null;
}

function loadAccount(accountId) {
  const primary = readJson(path.join(accountsDir(), `${accountId}.json`), null);
  if (primary) return { accountId, ...primary };

  const rawId = deriveRawAccountId(accountId);
  if (rawId) {
    const legacy = readJson(path.join(accountsDir(), `${rawId}.json`), null);
    if (legacy) return { accountId, ...legacy };
  }

  const legacySingle = readJson(
    path.join(resolveOpenClawStateDir(), "credentials", "openclaw-weixin", "credentials.json"),
    null,
  );
  if (legacySingle?.token) return { accountId, ...legacySingle };

  return null;
}

function resolveAccount() {
  const ids = listAccountIds();
  if (ids.length === 0) {
    throw new Error(
      `no Weixin account found. Run: node weixin-agent-bridge.mjs login`,
    );
  }
  if (ids.length > 1 && !process.env.WEIXIN_ACCOUNT_ID?.trim()) {
    throw new Error(
      `multiple Weixin accounts found (${ids.join(", ")}). Set WEIXIN_ACCOUNT_ID to choose one.`,
    );
  }

  const account = loadAccount(ids[0]);
  if (!account?.token?.trim()) {
    throw new Error(`account ${ids[0]} has no token. Re-run Weixin login.`);
  }

  return {
    accountId: ids[0],
    token: account.token.trim(),
    baseUrl: account.baseUrl?.trim() || DEFAULT_BASE_URL,
    cdnBaseUrl: account.cdnBaseUrl?.trim() || DEFAULT_CDN_BASE_URL,
  };
}

function syncPath(accountId) {
  return path.join(accountsDir(), `${accountId}.codex.sync.json`);
}

function lockDir(accountId) {
  return path.join(accountsDir(), `${accountId}.codex.lock`);
}

function dedupePath(accountId) {
  return path.join(accountsDir(), `${accountId}.codex.seen.json`);
}

function pendingPath(accountId) {
  return path.join(accountsDir(), `${accountId}.codex.pending.json`);
}

function bridgeStateDir() {
  return process.env.WEIXIN_BRIDGE_STATE_DIR?.trim() ||
    path.join(os.homedir(), ".codex", "weixin-agent-bridge");
}

function serverStateDir() {
  return process.env.WEIXIN_SERVER_STATE_DIR?.trim() ||
    path.join(bridgeStateDir(), "server");
}

function serverSecretPath() {
  return process.env.WEIXIN_SERVER_SECRET_FILE?.trim() ||
    path.join(serverStateDir(), "server.secret");
}

function clientsRegistryPath() {
  return process.env.WEIXIN_CLIENTS_FILE?.trim() ||
    path.join(serverStateDir(), "clients.json");
}

function clientTokenPath() {
  return process.env.WEIXIN_CLIENT_TOKEN_FILE?.trim() ||
    path.join(process.env.WEIXIN_CLIENT_STATE_DIR?.trim() || path.join(bridgeStateDir(), "client"), "client.secret");
}

function randomSecret() {
  return randomBytes(32).toString("hex");
}

function readOrCreateSecret(filePath) {
  const existing = readText(filePath).trim();
  if (existing) return existing;
  const secret = randomSecret();
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${secret}\n`, { encoding: "utf8", mode: 0o600 });
  try {
    fs.chmodSync(filePath, 0o600);
  } catch {}
  return secret;
}

function readClientsRegistry() {
  const parsed = readJson(clientsRegistryPath(), {});
  return parsed?.clients && typeof parsed.clients === "object" ? parsed.clients : {};
}

function saveClientsRegistry(clients) {
  fs.mkdirSync(path.dirname(clientsRegistryPath()), { recursive: true });
  writePrivateJson(clientsRegistryPath(), {
    clients,
    savedAt: new Date().toISOString(),
  });
}

function pruneClientsRegistry() {
  const clients = readClientsRegistry();
  const now = Date.now();
  const ttlMs = Number(process.env.WEIXIN_CLIENT_TTL_MS || DEFAULT_CLIENT_TTL_MS);
  let changed = false;
  for (const [id, client] of Object.entries(clients)) {
    if (now - Number(client.lastSeenMs || 0) > ttlMs) {
      delete clients[id];
      changed = true;
    }
  }
  if (changed) saveClientsRegistry(clients);
  return clients;
}

function currentServerSecret() {
  return readOrCreateSecret(serverSecretPath());
}

function currentClientToken() {
  return readOrCreateSecret(clientTokenPath());
}

function routePath(accountId) {
  return path.join(accountsDir(), `${accountId}.codex.routes.json`);
}

function agentsConfigPath() {
  return process.env.WEIXIN_AGENTS_CONFIG?.trim() ||
    path.join(os.homedir(), ".codex", "weixin-bridge", "agents.json");
}

function loadAgentsConfig() {
  const configured = readJson(agentsConfigPath(), {});
  const agents = configured?.agents && typeof configured.agents === "object"
    ? configured.agents
    : {};
  const normalized = {};
  for (const [id, agent] of Object.entries(agents)) {
    if (!/^[a-zA-Z0-9_-]{1,32}$/.test(id) || !agent || typeof agent !== "object") continue;
    normalized[id] = {
      id,
      label: String(agent.label || id),
      type: agent.type === "remote" ? "remote" : "local",
      url: String(agent.url || "").trim(),
      token: String(agent.token || "").trim(),
      cwd: String(agent.cwd || "").trim(),
      model: String(agent.model || "").trim(),
      agentType: String(agent.agentType || "").trim(),
      timeoutMs: Number(agent.timeoutMs || DEFAULT_AGENT_TIMEOUT_MS),
    };
  }
  if (!normalized.local) {
    normalized.local = {
      id: "local",
      label: "本机",
      type: "local",
      cwd: agentCwd(),
      model: agentEnv("MODEL"),
      agentType: resolveAgentType(),
      timeoutMs: DEFAULT_AGENT_TIMEOUT_MS,
    };
  }
  for (const [id, client] of Object.entries(pruneClientsRegistry())) {
    if (!/^[a-zA-Z0-9_-]{1,32}$/.test(id)) continue;
    normalized[id] = {
      id,
      label: String(client.label || id),
      type: "remote",
      url: String(client.executeUrl || "").trim(),
      token: String(client.clientToken || "").trim(),
      cwd: String(client.cwd || "").trim(),
      model: String(client.model || "").trim(),
      agentType: String(client.agentType || "").trim(),
      timeoutMs: Number(client.timeoutMs || DEFAULT_AGENT_TIMEOUT_MS),
      online: true,
      lastSeenMs: Number(client.lastSeenMs || 0),
    };
  }
  return {
    defaultAgent: String(configured.defaultAgent || "local"),
    agents: normalized,
  };
}

function loadUserAgent(accountId, fromUserId) {
  const parsed = readJson(routePath(accountId), {});
  return parsed?.routes?.[fromUserId] || loadAgentsConfig().defaultAgent || "local";
}

function saveUserAgent(accountId, fromUserId, agentId) {
  const parsed = readJson(routePath(accountId), {});
  const routes = parsed?.routes && typeof parsed.routes === "object" ? parsed.routes : {};
  routes[fromUserId] = agentId;
  writeJson(routePath(accountId), {
    routes,
    savedAt: new Date().toISOString(),
  });
}

function agentCommand(body) {
  const normalized = String(body || "").trim();
  if (/^\/agents?$/i.test(normalized)) return { action: "list" };
  if (/^\/agents?\s+status$/i.test(normalized)) return { action: "status" };
  const match = normalized.match(/^\/agent\s+([a-zA-Z0-9_-]{1,32})$/i);
  if (match) return { action: "select", id: match[1] };
  return null;
}

function formatAgentsList(config, currentId) {
  return Object.values(config.agents)
    .map((agent) => `${agent.id === currentId ? "●" : "○"} ${agent.id}：${agent.label}${agent.type === "remote" ? "（远程" : "（本机"}${agent.agentType ? `/${agent.agentType}` : ""}）`)
    .join("\n");
}

function describeAgent(agent) {
  const executor = agent.agentType ? `\n执行器：${agent.agentType}` : "";
  if (agent.type === "remote") return `${agent.label}（${agent.id}）${executor}\n地址：${agent.url}`;
  return `${agent.label}（${agent.id}）${executor}\n目录：${agent.cwd || agentCwd()}`;
}

function conversationsDir(accountId) {
  return path.join(os.homedir(), ".codex", "weixin-bridge", "conversations", sanitizeFileName(accountId));
}

function conversationPath(accountId, fromUserId) {
  return path.join(conversationsDir(accountId), `${sanitizeFileName(fromUserId)}.json`);
}

function uploadsDir(accountId) {
  return path.join(os.homedir(), ".codex", "weixin-bridge", "uploads", sanitizeFileName(accountId));
}

function loadSyncBuf(accountId) {
  return readJson(syncPath(accountId), {})?.get_updates_buf || "";
}

function saveSyncBuf(accountId, getUpdatesBuf) {
  writeJson(syncPath(accountId), {
    get_updates_buf: getUpdatesBuf || "",
    savedAt: new Date().toISOString(),
  });
}

function acquireInstanceLock(accountId) {
  const dir = lockDir(accountId);
  try {
    fs.mkdirSync(dir, { recursive: false });
  } catch (error) {
    if (error.code !== "EEXIST") throw error;

    const meta = readJson(path.join(dir, "lock.json"), {});
    const pid = Number(meta?.pid || 0);
    const alive = pid > 0 && (() => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    })();
    if (alive) {
      throw new Error(`another codex-weixin process is already running, pid=${pid}`);
    }

    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: false });
  }

  writeJson(path.join(dir, "lock.json"), {
    pid: process.pid,
    startedAt: new Date().toISOString(),
  });
  state.lockDir = dir;
}

function releaseInstanceLock() {
  if (!state.lockDir) return;
  fs.rmSync(state.lockDir, { recursive: true, force: true });
  state.lockDir = "";
}

function messageKey(message, body) {
  return [
    message.msg_id || message.message_id || message.client_id || "",
    message.context_token || "",
    message.from_user_id || "",
    message.create_time_ms || "",
    body,
  ].join("|");
}

function markMessageSeen(accountId, key) {
  const now = Date.now();
  const maxAgeMs = Number(process.env.WEIXIN_DEDUPE_TTL_MS || 24 * 60 * 60 * 1000);
  const parsed = readJson(dedupePath(accountId), {});
  const seen = parsed?.seen && typeof parsed.seen === "object" ? parsed.seen : {};

  for (const [existingKey, timestamp] of Object.entries(seen)) {
    if (now - Number(timestamp || 0) > maxAgeMs) delete seen[existingKey];
  }

  if (seen[key]) return false;
  seen[key] = now;
  writeJson(dedupePath(accountId), {
    seen,
    savedAt: new Date().toISOString(),
  });
  return true;
}

function loadPendingApprovals(accountId) {
  const parsed = readJson(pendingPath(accountId), {});
  const approvals = parsed?.approvals && typeof parsed.approvals === "object" ? parsed.approvals : {};
  const now = Date.now();
  const maxAgeMs = Number(process.env.WEIXIN_APPROVAL_TTL_MS || 6 * 60 * 60 * 1000);

  let changed = false;
  for (const [id, approval] of Object.entries(approvals)) {
    if (now - Number(approval?.createdAtMs || 0) > maxAgeMs) {
      delete approvals[id];
      changed = true;
    }
  }
  if (changed) savePendingApprovals(accountId, approvals);
  return approvals;
}

function savePendingApprovals(accountId, approvals) {
  writeJson(pendingPath(accountId), {
    approvals,
    savedAt: new Date().toISOString(),
  });
}

function putPendingApproval(accountId, approval) {
  const approvals = loadPendingApprovals(accountId);
  approvals[approval.id] = approval;
  savePendingApprovals(accountId, approvals);
}

function takePendingApproval(accountId, id, fromUserId) {
  const approvals = loadPendingApprovals(accountId);
  const approval = approvals[id];
  if (!approval || approval.fromUserId !== fromUserId) return null;
  delete approvals[id];
  savePendingApprovals(accountId, approvals);
  return approval;
}

function getPendingApproval(accountId, id, fromUserId) {
  const approval = loadPendingApprovals(accountId)[id];
  if (!approval || approval.fromUserId !== fromUserId) return null;
  return approval;
}

function approvalCommand(body) {
  const normalized = String(body || "").trim();
  const match = normalized.match(/^(批准|同意|approve|yes|拒绝|取消|reject|no)\s+([A-Z0-9]{6,10})$/i);
  if (!match) return null;
  const action = /^(批准|同意|approve|yes)$/i.test(match[1]) ? "approve" : "reject";
  return { action, id: match[2].toUpperCase() };
}

function approvalListRequested(body) {
  return /^(待批准|审批列表|approval list|pending)$/i.test(String(body || "").trim());
}

function newApprovalId() {
  return randomUUID().replace(/-/g, "").slice(0, 8).toUpperCase();
}

function baseInfo() {
  return {
    channel_version: VERSION,
    bot_agent: process.env.WEIXIN_BOT_AGENT?.trim() || `CodexWeixinBridge/${VERSION}`,
  };
}

function buildHeaders(token) {
  const headers = {
    "Content-Type": "application/json",
    AuthorizationType: "ilink_bot_token",
    "X-WECHAT-UIN": Buffer.from(String(Math.floor(Math.random() * 0xffffffff))).toString("base64"),
    "iLink-App-Id": "bot",
    "iLink-App-ClientVersion": "1",
  };
  if (token?.trim()) headers.Authorization = `Bearer ${token.trim()}`;
  return headers;
}

function buildPublicHeaders() {
  const randomUin = Buffer.from(String(Math.floor(Math.random() * 0xffffffff))).toString("base64");
  return {
    "Content-Type": "application/json",
    "X-WECHAT-UIN": randomUin,
    "iLink-App-Id": "bot",
    "iLink-App-ClientVersion": "1",
  };
}

async function fetchJson(method, baseUrl, endpoint, body = null, timeoutMs = 15_000, headers = buildPublicHeaders()) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const url = new URL(endpoint, baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`);
  try {
    const response = await fetch(url, {
      method,
      headers,
      ...(body == null ? {} : { body: JSON.stringify(body) }),
      signal: controller.signal,
    });
    const raw = await response.text();
    if (!response.ok) throw new Error(`${endpoint} ${response.status}: ${raw}`);
    return raw ? JSON.parse(raw) : {};
  } finally {
    clearTimeout(timeout);
  }
}

async function postJson(account, endpoint, body, timeoutMs = 15_000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const url = new URL(endpoint, account.baseUrl.endsWith("/") ? account.baseUrl : `${account.baseUrl}/`);
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: buildHeaders(account.token),
      body: JSON.stringify({ ...body, base_info: baseInfo() }),
      signal: controller.signal,
    });
    const raw = await response.text();
    if (!response.ok) throw new Error(`${endpoint} ${response.status}: ${raw}`);
    return raw ? JSON.parse(raw) : {};
  } finally {
    clearTimeout(timeout);
  }
}

async function notifyStart(account) {
  try {
    await postJson(account, "ilink/bot/msg/notifystart", {}, 10_000);
  } catch (error) {
    warn(`notifyStart failed: ${error.message}`);
  }
}

async function notifyStop(account) {
  try {
    await postJson(account, "ilink/bot/msg/notifystop", {}, 10_000);
  } catch (error) {
    warn(`notifyStop failed: ${error.message}`);
  }
}

function localBotTokenList() {
  const tokens = [];
  for (const accountId of readAccountIndex().slice().reverse()) {
    const token = loadAccount(accountId)?.token?.trim();
    if (token) tokens.push(token);
    if (tokens.length >= 10) break;
  }
  return tokens;
}

async function fetchLoginQRCode(baseUrl, botType) {
  return fetchJson(
    "POST",
    baseUrl,
    `ilink/bot/get_bot_qrcode?bot_type=${encodeURIComponent(botType)}`,
    { local_token_list: localBotTokenList() },
    15_000,
  );
}

async function pollLoginStatus(baseUrl, qrcode, verifyCode = "") {
  const suffix = verifyCode ? `&verify_code=${encodeURIComponent(verifyCode)}` : "";
  try {
    return await fetchJson(
      "GET",
      baseUrl,
      `ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcode)}${suffix}`,
      null,
      QR_LONG_POLL_TIMEOUT_MS,
    );
  } catch (error) {
    if (error.name === "AbortError") return { status: "wait" };
    warn(`login status poll failed, retrying: ${error.message}`);
    return { status: "wait" };
  }
}

async function displayLoginQRCode(qrcodeUrl) {
  try {
    const qrterm = await import("qrcode-terminal");
    qrterm.default.generate(qrcodeUrl, { small: true });
  } catch {}
  console.log("请用手机微信扫描下面的二维码链接完成绑定：");
  console.log(qrcodeUrl);
}

async function readLine(prompt) {
  process.stdout.write(prompt);
  return new Promise((resolve) => {
    let input = "";
    const onData = (chunk) => {
      input += chunk.toString();
      if (!input.includes("\n")) return;
      process.stdin.off("data", onData);
      process.stdin.pause();
      resolve(input.trim());
    };
    process.stdin.setEncoding("utf-8");
    process.stdin.resume();
    process.stdin.on("data", onData);
  });
}

async function refreshLoginQRCode(login, baseUrl, botType, count, maxCount) {
  if (count > maxCount) throw new Error("二维码多次失效，连接流程已停止。请稍后再试。");
  console.log(`二维码已过期，正在刷新 (${count}/${maxCount})...`);
  const response = await fetchLoginQRCode(baseUrl, botType);
  if (!response?.qrcode || !response?.qrcode_img_content) {
    throw new Error("微信服务器未返回二维码。");
  }
  login.qrcode = response.qrcode;
  login.qrcodeUrl = response.qrcode_img_content;
  login.currentBaseUrl = baseUrl;
  await displayLoginQRCode(login.qrcodeUrl);
}

async function loginWeixin() {
  const baseUrl = process.env.WEIXIN_LOGIN_BASE_URL?.trim() || DEFAULT_BASE_URL;
  const botType = process.env.WEIXIN_LOGIN_BOT_TYPE?.trim() || DEFAULT_ILINK_BOT_TYPE;
  const timeoutMs = Number(process.env.WEIXIN_LOGIN_TIMEOUT_MS || LOGIN_TIMEOUT_MS);
  const maxRefresh = Number(process.env.WEIXIN_LOGIN_QR_REFRESHES || 3);

  const response = await fetchLoginQRCode(baseUrl, botType);
  if (!response?.qrcode || !response?.qrcode_img_content) {
    throw new Error("微信服务器未返回二维码。");
  }

  const login = {
    qrcode: response.qrcode,
    qrcodeUrl: response.qrcode_img_content,
    currentBaseUrl: baseUrl,
    verifyCode: "",
  };
  await displayLoginQRCode(login.qrcodeUrl);
  console.log(`等待扫码确认，超时时间 ${Math.round(timeoutMs / 1000)} 秒。`);

  const deadline = Date.now() + timeoutMs;
  let scannedPrinted = false;
  let refreshCount = 1;

  while (Date.now() < deadline) {
    const status = await pollLoginStatus(login.currentBaseUrl, login.qrcode, login.verifyCode);
    switch (status?.status) {
      case "wait":
        break;
      case "scaned":
        login.verifyCode = "";
        if (!scannedPrinted) {
          console.log("已扫码，等待手机确认...");
          scannedPrinted = true;
        }
        break;
      case "need_verifycode":
        login.verifyCode = await readLine(login.verifyCode ? "数字不匹配，请重新输入手机微信显示的数字：" : "输入手机微信显示的数字：");
        continue;
      case "verify_code_blocked":
        login.verifyCode = "";
        refreshCount += 1;
        await refreshLoginQRCode(login, baseUrl, botType, refreshCount, maxRefresh);
        scannedPrinted = false;
        break;
      case "expired":
        refreshCount += 1;
        await refreshLoginQRCode(login, baseUrl, botType, refreshCount, maxRefresh);
        scannedPrinted = false;
        break;
      case "scaned_but_redirect":
        if (status.redirect_host) {
          login.currentBaseUrl = `https://${status.redirect_host}`;
          log(`login redirected to ${status.redirect_host}`);
        }
        break;
      case "binded_redirect":
        console.log("此微信机器人已经绑定过，保留现有本地账号。");
        return;
      case "confirmed": {
        if (!status.ilink_bot_id) throw new Error("登录失败：服务器未返回 ilink_bot_id。");
        if (!status.bot_token) throw new Error("登录失败：服务器未返回 bot_token。");
        const accountId = normalizeAccountId(status.ilink_bot_id);
        saveAccount(accountId, {
          token: status.bot_token,
          baseUrl: status.baseurl || login.currentBaseUrl || baseUrl,
          userId: status.ilink_user_id || "",
        });
        clearStaleAccountsForUserId(accountId, status.ilink_user_id || "");
        console.log(`登录成功，账号 ID: ${accountId}`);
        console.log(`状态目录: ${weixinStateDir()}`);
        return;
      }
      default:
        warn(`unknown login status: ${status?.status || "(empty)"}`);
        break;
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }

  throw new Error("登录超时，请重试。");
}

async function getUpdates(account, getUpdatesBuf) {
  return postJson(
    account,
    "ilink/bot/getupdates",
    { get_updates_buf: getUpdatesBuf || "" },
    Number(process.env.WEIXIN_LONGPOLL_MS || DEFAULT_TIMEOUT_MS) + 5_000,
  );
}

async function sendText(account, to, text, contextToken) {
  const chunks = splitMessage(text, Number(process.env.WEIXIN_REPLY_CHARS || 3500));
  for (const chunk of chunks) {
    const clientId = `codex-weixin-${randomUUID()}`;
    const response = await postJson(account, "ilink/bot/sendmessage", {
      msg: {
        from_user_id: "",
        to_user_id: to,
        client_id: clientId,
        message_type: 2,
        message_state: 2,
        context_token: contextToken,
        item_list: [{ type: 1, text_item: { text: chunk } }],
      },
    });
    if (response.ret && response.ret !== 0) {
      throw new Error(`sendmessage ret=${response.ret} errmsg=${response.errmsg || ""}`);
    }
    log(`sendmessage ok to=${to} client_id=${clientId} ret=${response.ret ?? 0}`);
  }
}

function splitMessage(text, maxChars) {
  const normalized = String(text || "").trim() || "(empty response)";
  if (normalized.length <= maxChars) return [normalized];
  const chunks = [];
  for (let i = 0; i < normalized.length; i += maxChars) {
    chunks.push(normalized.slice(i, i + maxChars));
  }
  return chunks;
}

function readConfigValue(name) {
  const configPath = path.join(os.homedir(), ".codex", "config.toml");
  const raw = readText(configPath);
  const match = raw.match(new RegExp(`^${name}\\s*=\\s*"([^"]+)"`, "m"));
  return match?.[1] || "";
}

function configuredCodexModel() {
  return process.env.WEIXIN_CODEX_MODEL?.trim() || readConfigValue("model") || "default";
}

function configuredCodexProvider() {
  return readConfigValue("model_provider") || "default";
}

function localReplyFor(body) {
  const normalized = String(body || "").toLowerCase().replace(/\s+/g, " ");
  if (
    /\bmodel\s*id\b/.test(normalized) ||
    /模型\s*(id|ID|编号|名称)/.test(body) ||
    /用的.*模型/.test(body) ||
    /你.*模型/.test(body)
  ) {
    return `当前 Codex 配置的 model id 是 ${configuredCodexModel()}，provider 是 ${configuredCodexProvider()}。`;
  }
  return null;
}

function requiresWechatApproval(body) {
  const text = String(body || "");
  if (!text.trim()) return false;

  const commandLike = /(^|\n)\s*(npm|pnpm|yarn|node|python3?|pip|git|systemctl|docker|curl|wget|bash|sh|rm|cp|mv|chmod|chown|sed|awk|cat)\b/i;
  const pathLike = /(^|\s)(\/root|\/etc|\/tmp|~\/|\.[A-Za-z0-9_-]+\/|[A-Za-z0-9_.-]+\.(js|mjs|ts|tsx|jsx|py|go|rs|java|php|rb|sh|toml|json|yaml|yml|md|css|html))\b/i;
  const devIntent =
    /(修改|改造|实现|开发|修复|重构|优化|新增|添加|删除|安装|部署|重启|运行|执行|测试|提交|回滚|配置|写入|创建|生成|接入|升级|迁移)/.test(text) ||
    /\b(fix|implement|change|modify|refactor|install|deploy|restart|run|execute|test|commit|rollback|configure|create|generate|upgrade|migrate)\b/i.test(text);
  const localTarget =
    /(这个|本机|服务器|项目|仓库|代码|文件|目录|服务|桥接器|systemd|配置|依赖|脚本|repo|project|codebase|file|service)/i.test(text) ||
    commandLike.test(text) ||
    pathLike.test(text);

  return devIntent && localTarget;
}

function sanitizeFileName(name) {
  return path.basename(String(name || "media.bin")).replace(/[^a-zA-Z0-9._-]+/g, "-") || "media.bin";
}

function extensionFromContent(buffer, fallback = ".bin") {
  if (buffer.length >= 4 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return ".jpg";
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return ".png";
  if (buffer.length >= 6 && ["GIF87a", "GIF89a"].includes(buffer.subarray(0, 6).toString("ascii"))) return ".gif";
  if (buffer.length >= 12 && buffer.subarray(4, 12).toString("ascii") === "ftypheic") return ".heic";
  if (buffer.length >= 12 && buffer.subarray(4, 12).toString("ascii") === "ftypheix") return ".heic";
  if (buffer.length >= 12 && buffer.subarray(4, 12).toString("ascii") === "ftyphevc") return ".heic";
  if (buffer.length >= 12 && buffer.subarray(4, 12).toString("ascii") === "ftypmif1") return ".heic";
  if (buffer.length >= 12 && buffer.subarray(4, 12).toString("ascii") === "ftypwebp") return ".webp";
  return fallback;
}

function isImagePath(filePath) {
  return /\.(png|jpe?g|gif|webp|heic|heif)$/i.test(filePath);
}

function truncateText(text, maxChars = Number(process.env.WEIXIN_FILE_PREVIEW_CHARS || 12_000)) {
  const value = String(text || "").trim();
  if (value.length <= maxChars) return value;
  return `${value.slice(0, maxChars)}\n...[truncated ${value.length - maxChars} chars]`;
}

function truncateMemoryText(text) {
  return truncateText(text, Number(process.env.WEIXIN_MEMORY_MESSAGE_CHARS || 1200));
}

function loadConversation(accountId, fromUserId) {
  const parsed = readJson(conversationPath(accountId, fromUserId), {});
  return Array.isArray(parsed?.messages) ? parsed.messages : [];
}

function saveConversation(accountId, fromUserId, messages) {
  const maxMessages = Number(process.env.WEIXIN_MEMORY_MESSAGES || 24);
  const kept = messages
    .filter((message) => ["user", "assistant"].includes(message?.role) && String(message?.text || "").trim())
    .slice(-maxMessages)
    .map((message) => ({
      role: message.role,
      text: truncateMemoryText(message.text),
      at: message.at || new Date().toISOString(),
    }));
  writeJson(conversationPath(accountId, fromUserId), {
    messages: kept,
    savedAt: new Date().toISOString(),
  });
}

function appendConversationTurn(accountId, fromUserId, userText, assistantText) {
  const messages = loadConversation(accountId, fromUserId);
  const now = new Date().toISOString();
  messages.push({ role: "user", text: userText, at: now });
  messages.push({ role: "assistant", text: assistantText, at: now });
  saveConversation(accountId, fromUserId, messages);
}

function formatConversationHistory(messages) {
  if (!messages.length) return "(none)";
  return messages
    .map((message) => {
      const label = message.role === "assistant" ? "assistant" : "user";
      return `${label}: ${truncateMemoryText(message.text)}`;
    })
    .join("\n\n");
}

function xmlDecode(text) {
  return String(text || "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

function stripXmlTags(xml) {
  return xmlDecode(String(xml || "").replace(/<[^>]+>/g, ""));
}

function unzipText(filePath, entry) {
  const result = spawnSync("unzip", ["-p", filePath, entry], {
    encoding: "utf8",
    maxBuffer: 20 * 1024 * 1024,
  });
  if (result.status !== 0) return "";
  return result.stdout || "";
}

function unzipList(filePath) {
  const result = spawnSync("unzip", ["-Z1", filePath], {
    encoding: "utf8",
    maxBuffer: 2 * 1024 * 1024,
  });
  if (result.status !== 0) return [];
  return result.stdout.split(/\r?\n/).filter(Boolean);
}

function previewTextFile(filePath) {
  const stat = fs.statSync(filePath);
  const maxBytes = Number(process.env.WEIXIN_FILE_READ_BYTES || 512 * 1024);
  const fd = fs.openSync(filePath, "r");
  try {
    const buffer = Buffer.alloc(Math.min(stat.size, maxBytes));
    const bytes = fs.readSync(fd, buffer, 0, buffer.length, 0);
    return truncateText(buffer.subarray(0, bytes).toString("utf8"));
  } finally {
    fs.closeSync(fd);
  }
}

function previewDocx(filePath) {
  const xml = unzipText(filePath, "word/document.xml");
  if (!xml) return "未能读取 docx 正文。";
  const paragraphs = [...xml.matchAll(/<w:p\b[\s\S]*?<\/w:p>/g)]
    .map((match) => stripXmlTags(match[0]).replace(/\s+/g, " ").trim())
    .filter(Boolean);
  return truncateText(paragraphs.join("\n"));
}

function xlsxSharedStrings(filePath) {
  const xml = unzipText(filePath, "xl/sharedStrings.xml");
  if (!xml) return [];
  return [...xml.matchAll(/<si\b[\s\S]*?<\/si>/g)].map((match) => stripXmlTags(match[0]).trim());
}

function xlsxSheetNameMap(filePath) {
  const workbook = unzipText(filePath, "xl/workbook.xml");
  const rels = unzipText(filePath, "xl/_rels/workbook.xml.rels");
  const relMap = {};
  for (const match of rels.matchAll(/<Relationship\b([^>]+)>/g)) {
    const attrs = match[1];
    const id = attrs.match(/\bId="([^"]+)"/)?.[1];
    const target = attrs.match(/\bTarget="([^"]+)"/)?.[1];
    if (id && target) relMap[id] = target.startsWith("/") ? target.slice(1) : `xl/${target}`;
  }
  const names = {};
  for (const match of workbook.matchAll(/<sheet\b([^>]+?)\/>/g)) {
    const attrs = match[1];
    const name = xmlDecode(attrs.match(/\bname="([^"]+)"/)?.[1] || "");
    const relId = attrs.match(/\br:id="([^"]+)"/)?.[1];
    if (name && relId && relMap[relId]) names[relMap[relId]] = name;
  }
  return names;
}

function xlsxCellValue(cellXml, sharedStrings) {
  const type = cellXml.match(/\bt="([^"]+)"/)?.[1] || "";
  if (type === "inlineStr") return stripXmlTags(cellXml.match(/<is\b[\s\S]*?<\/is>/)?.[0] || "");
  const raw = stripXmlTags(cellXml.match(/<v\b[^>]*>[\s\S]*?<\/v>/)?.[0] || "").trim();
  if (type === "s") return sharedStrings[Number(raw)] || raw;
  if (type === "b") return raw === "1" ? "TRUE" : "FALSE";
  return raw;
}

function previewXlsx(filePath) {
  const entries = unzipList(filePath).filter((entry) => /^xl\/worksheets\/sheet\d+\.xml$/.test(entry));
  if (entries.length === 0) return "未找到 xlsx 工作表。";
  const sharedStrings = xlsxSharedStrings(filePath);
  const sheetNames = xlsxSheetNameMap(filePath);
  const maxSheets = Number(process.env.WEIXIN_XLSX_MAX_SHEETS || 5);
  const maxRows = Number(process.env.WEIXIN_XLSX_MAX_ROWS || 40);
  const sections = [];

  for (const entry of entries.slice(0, maxSheets)) {
    const xml = unzipText(filePath, entry);
    const rows = [];
    for (const rowMatch of xml.matchAll(/<row\b[\s\S]*?<\/row>/g)) {
      const cells = [];
      for (const cellMatch of rowMatch[0].matchAll(/<c\b[\s\S]*?<\/c>/g)) {
        cells.push(xlsxCellValue(cellMatch[0], sharedStrings));
      }
      if (cells.some((cell) => cell !== "")) rows.push(cells.join("\t"));
      if (rows.length >= maxRows) break;
    }
    sections.push(`工作表: ${sheetNames[entry] || path.basename(entry, ".xml")}\n${rows.join("\n") || "(empty)"}`);
  }

  if (entries.length > maxSheets) sections.push(`另有 ${entries.length - maxSheets} 个工作表未预览。`);
  return truncateText(sections.join("\n\n"));
}

function previewFile(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const name = path.basename(filePath);
  try {
    if ([".txt", ".md", ".csv", ".tsv", ".json", ".jsonl", ".log", ".xml", ".html", ".css", ".js", ".mjs", ".ts", ".tsx", ".jsx", ".py", ".sh", ".toml", ".yaml", ".yml", ".ini", ".conf"].includes(ext)) {
      return `文件: ${name}\n类型: text\n内容预览:\n${previewTextFile(filePath)}`;
    }
    if (ext === ".docx") {
      return `文件: ${name}\n类型: docx\n正文预览:\n${previewDocx(filePath)}`;
    }
    if (ext === ".xlsx") {
      return `文件: ${name}\n类型: xlsx\n表格预览:\n${previewXlsx(filePath)}`;
    }
    if (ext === ".doc" || ext === ".xls") {
      return `文件: ${name}\n类型: ${ext.slice(1)}\n已保存到 ${filePath}。当前未安装旧版 Office 解析工具，无法自动抽取内容。`;
    }
    if (ext === ".pdf") {
      return `文件: ${name}\n类型: pdf\n已保存到 ${filePath}。当前未安装 PDF 文本抽取工具，无法自动抽取内容。`;
    }
    return `文件: ${name}\n类型: ${ext.slice(1) || "unknown"}\n已保存到 ${filePath}。`;
  } catch (error) {
    return `文件: ${name}\n已保存到 ${filePath}。\n预处理失败: ${error.message}`;
  }
}

function mediaDownloadUrl(media, cdnBaseUrl) {
  if (media?.full_url) return media.full_url;
  const query = media?.encrypt_query_param || "";
  if (!query) throw new Error("media has no download url");
  return `${cdnBaseUrl}/download?encrypted_query_param=${encodeURIComponent(query)}`;
}

function parseAesKey(aesKeyBase64, label) {
  const decoded = Buffer.from(aesKeyBase64 || "", "base64");
  if (decoded.length === 16) return decoded;
  if (decoded.length === 32 && /^[0-9a-fA-F]{32}$/.test(decoded.toString("ascii"))) {
    return Buffer.from(decoded.toString("ascii"), "hex");
  }
  throw new Error(`${label}: invalid aes_key length ${decoded.length}`);
}

function decryptAesEcb(buffer, aesKeyBase64, label) {
  const decipher = createDecipheriv("aes-128-ecb", parseAesKey(aesKeyBase64, label), null);
  decipher.setAutoPadding(true);
  return Buffer.concat([decipher.update(buffer), decipher.final()]);
}

async function fetchBuffer(url, timeoutMs = 30_000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(`download ${response.status}: ${body.slice(0, 300)}`);
    }
    return Buffer.from(await response.arrayBuffer());
  } finally {
    clearTimeout(timeout);
  }
}

async function saveMediaBuffer(accountId, buffer, fileName) {
  if (buffer.length > Number(process.env.WEIXIN_MEDIA_MAX_BYTES || MEDIA_MAX_BYTES)) {
    throw new Error(`media too large: ${buffer.length} bytes`);
  }
  const safeName = sanitizeFileName(fileName);
  const dir = uploadsDir(accountId);
  fs.mkdirSync(dir, { recursive: true });
  const parsed = path.parse(safeName);
  const ext = parsed.ext || extensionFromContent(buffer);
  const base = parsed.name || "media";
  const filePath = path.join(dir, `${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}-${base}${ext}`);
  fs.writeFileSync(filePath, buffer);
  return filePath;
}

async function downloadMediaItem(account, item) {
  if (item?.type === 2) {
    const image = item.image_item;
    const media = image?.media;
    if (!media?.encrypt_query_param && !media?.full_url) return null;
    const aesKeyBase64 = image.aeskey ? Buffer.from(image.aeskey, "hex").toString("base64") : media.aes_key;
    const downloaded = await fetchBuffer(mediaDownloadUrl(media, account.cdnBaseUrl));
    const buffer = aesKeyBase64 ? decryptAesEcb(downloaded, aesKeyBase64, "image") : downloaded;
    const filePath = await saveMediaBuffer(account.accountId, buffer, `image${extensionFromContent(buffer, ".jpg")}`);
    return { kind: "image", path: filePath };
  }

  if (item?.type === 4) {
    const file = item.file_item;
    const media = file?.media;
    if ((!media?.encrypt_query_param && !media?.full_url) || !media?.aes_key) return null;
    const downloaded = await fetchBuffer(mediaDownloadUrl(media, account.cdnBaseUrl));
    const buffer = decryptAesEcb(downloaded, media.aes_key, "file");
    const filePath = await saveMediaBuffer(account.accountId, buffer, file.file_name || "file.bin");
    return { kind: isImagePath(filePath) ? "image" : "file", path: filePath, name: file.file_name || path.basename(filePath) };
  }

  return null;
}

async function extractMessageContent(account, message) {
  const parts = [];
  const images = [];
  const files = [];
  for (const item of message.item_list || []) {
    if (item?.type === 1 && item.text_item?.text) parts.push(String(item.text_item.text));
    if (item?.type === 3 && item.voice_item?.text) parts.push(`[voice] ${item.voice_item.text}`);
    if (item?.type === 2 || item?.type === 4) {
      try {
        const media = await downloadMediaItem(account, item);
        if (media?.kind === "image") {
          images.push(media.path);
          parts.push(`[image saved: ${media.path}]`);
        } else if (media?.kind === "file") {
          files.push(media.path);
          parts.push(`[file saved: ${media.name || path.basename(media.path)} -> ${media.path}]`);
          parts.push(previewFile(media.path));
        } else if (item?.type === 2) {
          parts.push("[image received: no downloadable media]");
        } else {
          parts.push(`[file received: ${item.file_item?.file_name || "unknown"}, no downloadable media]`);
        }
      } catch (error) {
        warn(`media download failed: ${error.message}`);
        parts.push(`[media download failed: ${error.message}]`);
      }
    }
    if (item?.type === 5) parts.push("[video received]");
  }
  return { body: parts.join("\n").trim(), images, files };
}

function parseExtraArgs(raw) {
  if (!raw?.trim()) return [];
  const result = [];
  let current = "";
  let quote = null;
  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw[i];
    if (quote) {
      if (ch === quote) quote = null;
      else current += ch;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
    } else if (/\s/.test(ch)) {
      if (current) {
        result.push(current);
        current = "";
      }
    } else {
      current += ch;
    }
  }
  if (current) result.push(current);
  return result;
}

function agentEnv(name, fallback = "") {
  const generic = process.env[`WEIXIN_AGENT_${name}`]?.trim();
  if (generic) return generic;
  return process.env[`WEIXIN_CODEX_${name}`]?.trim() || fallback;
}

function agentCwd() {
  return agentEnv("CWD", process.cwd());
}

function executableExists(binary) {
  if (!binary) return false;
  if (binary.includes(path.sep)) {
    try {
      fs.accessSync(binary, fs.constants.X_OK);
      return true;
    } catch {
      return false;
    }
  }
  return String(process.env.PATH || "")
    .split(path.delimiter)
    .filter(Boolean)
    .some((dir) => {
      try {
        fs.accessSync(path.join(dir, binary), fs.constants.X_OK);
        return true;
      } catch {
        return false;
      }
    });
}

function agentBinary(type) {
  return process.env.WEIXIN_AGENT_BIN?.trim() ||
    (type === "codex" ? process.env.WEIXIN_CODEX_BIN?.trim() : "") || type;
}

function resolveAgentType() {
  const explicit = process.env.WEIXIN_AGENT_TYPE?.trim().toLowerCase();
  if (explicit) {
    if (!AGENT_TYPES.includes(explicit)) {
      throw new Error(`WEIXIN_AGENT_TYPE must be one of: ${AGENT_TYPES.join(", ")}`);
    }
    if (!executableExists(agentBinary(explicit))) {
      throw new Error(`${explicit} executable not found: ${agentBinary(explicit)}`);
    }
    return explicit;
  }
  if (process.env.WEIXIN_AGENT_BIN?.trim()) {
    throw new Error("WEIXIN_AGENT_BIN requires an explicit WEIXIN_AGENT_TYPE");
  }
  // A legacy custom binary is assumed to implement the Codex CLI contract.
  if (process.env.WEIXIN_CODEX_BIN?.trim()) return "codex";
  const detected = AGENT_TYPES.filter((type) => executableExists(agentBinary(type)));
  if (!detected.length) {
    throw new Error(`no supported Agent CLI found; set WEIXIN_AGENT_TYPE to one of: ${AGENT_TYPES.join(", ")}`);
  }
  if (detected.length > 1) {
    warn(`multiple Agent CLIs detected (${detected.join(", ")}); using ${detected[0]}. Set WEIXIN_AGENT_TYPE to choose explicitly`);
  }
  return detected[0];
}

function buildCodexPrompt(message, body, history = []) {
  return [
    "你正在通过微信回复用户。请直接回答用户，不要提到桥接器实现细节。",
    "除非用户明确要求操作本机文件或运行命令，否则只给出普通对话回答。",
    "下面的对话历史来自同一微信用户，按时间升序排列；回答追问、代词引用或用户让你临时记住的内容时，应优先参考它。",
    "",
    `微信用户: ${message.from_user_id || "unknown"}`,
    `消息时间: ${message.create_time_ms ? new Date(message.create_time_ms).toISOString() : "unknown"}`,
    "",
    "最近对话历史:",
    formatConversationHistory(history),
    "",
    "用户消息:",
    body,
  ].join("\n");
}

function buildApprovalPlanPrompt(message, body, history = []) {
  return [
    "你正在通过微信为用户处理一个可能会修改本机或运行命令的开发任务。",
    "当前阶段只能做审批前计划：不要修改文件，不要运行会写入、安装、联网、重启、删除或提交的命令。",
    "请用中文输出一个简短执行计划，最多 8 行。",
    "必须包含：预计改动、可能运行的验证命令、需要注意的风险。",
    "不要说已经执行，也不要要求用户在终端操作。",
    "",
    `微信用户: ${message.from_user_id || "unknown"}`,
    `消息时间: ${message.create_time_ms ? new Date(message.create_time_ms).toISOString() : "unknown"}`,
    "",
    "最近对话历史:",
    formatConversationHistory(history),
    "",
    "用户原始任务:",
    body,
  ].join("\n");
}

function buildApprovedCodexPrompt(approval, history = []) {
  const attachments = [
    ...(approval.imagePaths || []).map((filePath) => `图片: ${filePath}`),
    ...(approval.filePaths || []).map((filePath) => `文件: ${filePath}`),
  ];
  return [
    "你正在通过微信回复用户。用户已经通过微信批准执行下面的开发任务。",
    "可以按任务需要修改本机文件、运行必要命令和做验证。",
    "如任务涉及附件，附件已保存到本机；可以读取下方文件路径继续分析。",
    "仍然不要执行与任务无关的高风险操作；不要删除无关数据；不要泄露密钥。",
    "完成后用中文简短说明改了什么、验证结果，以及任何未完成事项。",
    "",
    `批准码: ${approval.id}`,
    `微信用户: ${approval.fromUserId || "unknown"}`,
    `原消息时间: ${approval.messageTime || "unknown"}`,
    "",
    "最近对话历史:",
    formatConversationHistory(history),
    "",
    "审批前计划:",
    approval.plan || "(none)",
    "",
    "附件:",
    attachments.length ? attachments.join("\n") : "(none)",
    "",
    "用户原始任务:",
    approval.body,
  ].join("\n");
}

function formatApprovalRequest(id, plan) {
  return [
    `待批准任务 ${id}`,
    "",
    plan,
    "",
    `回复“批准 ${id}”执行。`,
    `回复“拒绝 ${id}”取消。`,
  ].join("\n");
}

function formatPendingList(accountId, fromUserId) {
  const approvals = Object.values(loadPendingApprovals(accountId))
    .filter((approval) => approval.fromUserId === fromUserId)
    .sort((a, b) => Number(b.createdAtMs || 0) - Number(a.createdAtMs || 0));
  if (approvals.length === 0) return "当前没有待批准任务。";
  return approvals
    .map((approval) => {
      const firstLine = String(approval.body || "").trim().split(/\n/)[0].slice(0, 80);
      return `${approval.id}：${firstLine}`;
    })
    .join("\n");
}

async function runCodex(prompt, options = {}) {
  const outputFile = path.join(os.tmpdir(), `codex-weixin-${randomUUID()}.txt`);
  const args = [
    "-a",
    options.approval || agentEnv("APPROVAL", "never"),
    "exec",
    "--skip-git-repo-check",
    "-C",
    options.cwd || agentCwd(),
    "--sandbox",
    options.sandbox || agentEnv("SANDBOX", "read-only"),
    "--color",
    "never",
    "-o",
    outputFile,
  ];

  const model = options.model?.trim() || agentEnv("MODEL");
  if (model) {
    args.push("--model", model);
  }
  for (const imagePath of options.images || []) {
    args.push("--image", imagePath);
  }
  args.push(...parseExtraArgs(process.env.WEIXIN_AGENT_EXTRA_ARGS || process.env.WEIXIN_CODEX_EXTRA_ARGS), "-");

  const timeoutMs = Number(options.timeoutMs || agentEnv("TIMEOUT_MS", String(DEFAULT_CODEX_TIMEOUT_MS)));
  const startedAt = Date.now();
  const child = spawn(agentBinary("codex"), args, {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, NO_COLOR: "1" },
    detached: true,
  });
  if (child.pid) state.activeChildren.set(child.pid, child);
  log(`codex start pid=${child.pid || "unknown"} timeout_ms=${timeoutMs}`);

  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (data) => {
    stdout += data.toString();
  });
  child.stderr.on("data", (data) => {
    stderr += data.toString();
  });
  child.stdin.end(prompt);

  const result = await new Promise((resolve) => {
    let settled = false;
    let timedOut = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const timer = setTimeout(async () => {
      timedOut = true;
      await terminateProcessGroup(child);
      finish({ code: 124, timedOut: true });
    }, timeoutMs);
    child.on("error", (error) => {
      clearTimeout(timer);
      finish({ code: 1, error });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (child.pid) state.activeChildren.delete(child.pid);
      finish(timedOut ? { code: 124, timedOut: true } : { code });
    });
  });
  if (child.pid) state.activeChildren.delete(child.pid);

  let finalText = "";
  try {
    finalText = fs.existsSync(outputFile) ? fs.readFileSync(outputFile, "utf-8") : "";
  } finally {
    try {
      fs.unlinkSync(outputFile);
    } catch {}
  }

  if (result.code !== 0) {
    const reason = result.timedOut
      ? `codex timed out after ${timeoutMs}ms`
      : result.error?.message || `codex exited with code ${result.code}`;
    const tail = (result.timedOut ? reason : (stderr || stdout || reason)).trim();
    throw new Error(tail.slice(-1800));
  }
  log(`codex done pid=${child.pid || "unknown"} ms=${Date.now() - startedAt}`);
  return (finalText || stdout).trim();
}

async function runStreamAgent(type, prompt, options = {}) {
  const cwd = options.cwd || agentCwd();
  const model = options.model?.trim() || agentEnv("MODEL");
  const timeoutMs = Number(options.timeoutMs || agentEnv("TIMEOUT_MS", String(DEFAULT_CODEX_TIMEOUT_MS)));
  const attachmentNotes = [
    ...(options.images || []).map((filePath) => `图片附件: ${filePath}`),
    ...(options.files || []).map((filePath) => `文件附件: ${filePath}`),
  ];
  const effectivePrompt = attachmentNotes.length ? `${prompt}\n\n${attachmentNotes.join("\n")}` : prompt;
  let args;
  let stdin = effectivePrompt;
  if (type === "claude") {
    args = ["--print", "--output-format", "text"];
    if (model) args.push("--model", model);
  } else if (type === "opencode") {
    args = ["-p", effectivePrompt, "-f", "text", "-q", "-c", cwd];
    stdin = "";
  } else if (type === "agy") {
    args = ["--output-format", "text", `--print=${effectivePrompt}`];
    if (model) args.push("--model", model);
    if (agentEnv("APPROVAL", "never") === "never") {
      args.push("--dangerously-skip-permissions");
    }
    stdin = "";
  } else if (type === "codebuddy") {
    args = ["--print", "--output-format", "text"];
    if (model) args.push("--model", model);
    if (agentEnv("APPROVAL", "never") === "never") {
      args.push("--dangerously-skip-permissions");
    }
    args.push(effectivePrompt);
    stdin = "";
  } else {
    throw new Error(`unsupported Agent type: ${type}`);
  }
  args.push(...parseExtraArgs(process.env.WEIXIN_AGENT_EXTRA_ARGS));

  const startedAt = Date.now();
  const child = spawn(agentBinary(type), args, {
    cwd,
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, NO_COLOR: "1" },
    detached: true,
  });
  if (child.pid) state.activeChildren.set(child.pid, child);
  log(`${type} start pid=${child.pid || "unknown"} timeout_ms=${timeoutMs}`);
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (data) => { stdout += data.toString(); });
  child.stderr.on("data", (data) => { stderr += data.toString(); });
  child.stdin.end(stdin);

  const result = await new Promise((resolve) => {
    let settled = false;
    let timedOut = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const timer = setTimeout(async () => {
      timedOut = true;
      await terminateProcessGroup(child);
      finish({ code: 124, timedOut: true });
    }, timeoutMs);
    child.on("error", (error) => {
      clearTimeout(timer);
      finish({ code: 1, error });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      finish(timedOut ? { code: 124, timedOut: true } : { code });
    });
  });
  if (child.pid) state.activeChildren.delete(child.pid);
  if (result.code !== 0) {
    const reason = result.timedOut
      ? `${type} timed out after ${timeoutMs}ms`
      : result.error?.message || `${type} exited with code ${result.code}`;
    throw new Error((result.timedOut ? reason : (stderr || stdout || reason)).trim().slice(-1800));
  }
  log(`${type} done pid=${child.pid || "unknown"} ms=${Date.now() - startedAt}`);
  return stdout.trim();
}

async function runLocalAgent(prompt, options = {}) {
  const type = options.agentType || resolveAgentType();
  return type === "codex" ? runCodex(prompt, options) : runStreamAgent(type, prompt, options);
}

function encodeAgentAttachments(paths) {
  const maxBytes = Number(process.env.WEIXIN_AGENT_MAX_UPLOAD_BYTES || DEFAULT_AGENT_MAX_UPLOAD_BYTES);
  return (paths || []).flatMap((filePath) => {
    try {
      const stat = fs.statSync(filePath);
      if (!stat.isFile() || stat.size > maxBytes) {
        warn(`agent attachment skipped path=${filePath} size=${stat.size || "unknown"}`);
        return [];
      }
      return [{
        name: path.basename(filePath),
        path: filePath,
        dataBase64: fs.readFileSync(filePath).toString("base64"),
      }];
    } catch (error) {
      warn(`agent attachment read failed path=${filePath}: ${error.message}`);
      return [];
    }
  });
}

async function runRemoteAgent(agent, prompt, options = {}) {
  if (!agent.url) throw new Error(`agent ${agent.id} has no url`);
  const controller = new AbortController();
  const timeoutMs = Number(options.timeoutMs || agent.timeoutMs || DEFAULT_AGENT_TIMEOUT_MS);
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const headers = { "Content-Type": "application/json" };
  if (agent.token) headers.Authorization = `Bearer ${agent.token}`;
  try {
    const response = await fetch(agent.url, {
      method: "POST",
      headers,
      body: JSON.stringify({
        prompt,
        images: encodeAgentAttachments(options.images),
        files: encodeAgentAttachments(options.files),
        cwd: agent.cwd || "",
        model: agent.model || "",
        approval: options.approval || "",
        sandbox: options.sandbox || "",
        timeoutMs: timeoutMs,
      }),
      signal: controller.signal,
    });
    const raw = await response.text();
    let payload = {};
    try {
      payload = raw ? JSON.parse(raw) : {};
    } catch {
      payload = { error: raw };
    }
    if (!response.ok || payload.error) {
      throw new Error(payload.error || `agent ${agent.id} returned HTTP ${response.status}`);
    }
    return String(payload.text || "").trim() || "(empty response)";
  } finally {
    clearTimeout(timeout);
  }
}

async function runForAgent(agent, prompt, options = {}) {
  state.metrics.agentExecutions[agent.id] = Number(state.metrics.agentExecutions[agent.id] || 0) + 1;
  if (agent.type === "remote") {
    return runRemoteAgent(agent, prompt, options);
  }
  return runLocalAgent(prompt, {
    ...options,
    agentType: agent.agentType || options.agentType,
    cwd: agent.cwd || options.cwd,
    model: agent.model || options.model,
    timeoutMs: options.timeoutMs || agent.timeoutMs,
  });
}

function processGroupExists(pid) {
  try {
    process.kill(-pid, 0);
    return true;
  } catch {
    return false;
  }
}

function signalProcessGroup(child, signal) {
  if (!child?.pid) return;
  try {
    process.kill(-child.pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {}
  }
}

async function terminateProcessGroup(child) {
  if (!child?.pid) return;
  signalProcessGroup(child, "SIGTERM");
  const deadline = Date.now() + 2_000;
  while (processGroupExists(child.pid) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  if (processGroupExists(child.pid)) {
    signalProcessGroup(child, "SIGKILL");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  state.activeChildren.delete(child.pid);
}

async function terminateAllChildren() {
  await Promise.allSettled([...state.activeChildren.values()].map(terminateProcessGroup));
}

async function processMessage(account, message) {
  if (message.message_type === 2) return;
  const to = message.from_user_id;
  const { body, images, files } = await extractMessageContent(account, message);
  if (!to || !body) return;
  const key = messageKey(message, body);
  if (!markMessageSeen(account.accountId, key)) {
    log(`skip duplicate from=${to}`);
    return;
  }

  log(`inbound from=${to} chars=${body.length}`);
  try {
    const history = loadConversation(account.accountId, to);
    const agentsConfig = loadAgentsConfig();
    const currentAgentId = loadUserAgent(account.accountId, to);
    const currentAgent = agentsConfig.agents[currentAgentId] || null;
    const routeCommand = agentCommand(body);
    if (routeCommand) {
      if (routeCommand.action === "list") {
        const currentLabel = currentAgent ? currentAgent.id : `${currentAgentId}（当前不可用）`;
        const reply = `当前 Agent：${currentLabel}\n\n${formatAgentsList(agentsConfig, currentAgent?.id || "")}\n\n切换命令：/agent <id>`;
        await sendText(account, to, reply, message.context_token);
        appendConversationTurn(account.accountId, to, body, reply);
        return;
      }
      if (routeCommand.action === "status") {
        const reply = currentAgent
          ? `当前 Agent：${currentAgent.id}\n${describeAgent(currentAgent)}`
          : `当前 Agent：${currentAgentId}（当前不可用）\n请使用 /agents 查看在线节点并重新选择。`;
        await sendText(account, to, reply, message.context_token);
        appendConversationTurn(account.accountId, to, body, reply);
        return;
      }
      const selected = agentsConfig.agents[routeCommand.id];
      if (!selected) {
        const reply = `没有找到 Agent“${routeCommand.id}”。\n\n可用 Agent：\n${formatAgentsList(agentsConfig, currentAgent?.id || "")}`;
        await sendText(account, to, reply, message.context_token);
        appendConversationTurn(account.accountId, to, body, reply);
        return;
      }
      saveUserAgent(account.accountId, to, selected.id);
      const reply = `已切换到 ${selected.label}（${selected.id}）。\n${describeAgent(selected)}`;
      await sendText(account, to, reply, message.context_token);
      appendConversationTurn(account.accountId, to, body, reply);
      log(`agent selected id=${selected.id} from=${to}`);
      return;
    }

    const command = approvalCommand(body);
    if (command) {
      const pending = command.action === "approve"
        ? takePendingApproval(account.accountId, command.id, to)
        : getPendingApproval(account.accountId, command.id, to);
      if (!pending) {
        await sendText(account, to, `没有找到待处理任务 ${command.id}，可能已执行、已过期或不是你创建的。`, message.context_token);
        return;
      }
      if (command.action === "reject") {
        takePendingApproval(account.accountId, command.id, to);
        await sendText(account, to, `已取消任务 ${command.id}。`, message.context_token);
        return;
      }
      log(`approval accepted id=${command.id} from=${to}`);
      const approvedAgent = agentsConfig.agents[pending.agentId];
      if (!approvedAgent) {
        const reply = `任务 ${command.id} 绑定的 Agent“${pending.agentId}”当前不可用，已停止执行，不会回退到本机。`;
        await sendText(account, to, reply, pending.contextToken || message.context_token);
        appendConversationTurn(account.accountId, to, body, reply);
        return;
      }
      const reply = await runForAgent(approvedAgent, buildApprovedCodexPrompt(pending, history), {
        images: pending.imagePaths || [],
        files: pending.filePaths || [],
      });
      await sendText(account, to, reply, pending.contextToken || message.context_token);
      appendConversationTurn(account.accountId, to, body, reply);
      log(`approved task done id=${command.id} chars=${reply.length}`);
      return;
    }

    if (approvalListRequested(body)) {
      const reply = formatPendingList(account.accountId, to);
      await sendText(account, to, reply, message.context_token);
      appendConversationTurn(account.accountId, to, body, reply);
      return;
    }

    if (!currentAgent) {
      const reply = `当前 Agent“${currentAgentId}”不可用，消息未执行，也不会回退到本机。\n请使用 /agents 查看在线节点并通过 /agent <id> 重新选择。`;
      await sendText(account, to, reply, message.context_token);
      appendConversationTurn(account.accountId, to, body, reply);
      log(`agent unavailable id=${currentAgentId} from=${to}`);
      return;
    }

    const localReply = currentAgent.type === "local" ? localReplyFor(body) : null;
    if (localReply) {
      await sendText(account, to, localReply, message.context_token);
      appendConversationTurn(account.accountId, to, body, localReply);
      log(`replied to=${to} agent=${currentAgent.id} type=local-shortcut chars=${localReply.length}`);
      return;
    }

    if (requiresWechatApproval(body)) {
      const id = newApprovalId();
      const plan = await runForAgent(currentAgent, buildApprovalPlanPrompt(message, body, history), {
        approval: "never",
        sandbox: "read-only",
        images,
        files,
        timeoutMs: Number(process.env.WEIXIN_APPROVAL_PLAN_TIMEOUT_MS || DEFAULT_CODEX_TIMEOUT_MS),
      });
      putPendingApproval(account.accountId, {
        id,
        fromUserId: to,
        agentId: currentAgent.id,
        contextToken: message.context_token || "",
        body,
        plan,
        imagePaths: images,
        filePaths: files,
        createdAtMs: Date.now(),
        createdAt: new Date().toISOString(),
        messageTime: message.create_time_ms ? new Date(message.create_time_ms).toISOString() : "unknown",
      });
      const reply = formatApprovalRequest(id, plan);
      await sendText(account, to, reply, message.context_token);
      appendConversationTurn(account.accountId, to, body, reply);
      log(`approval requested id=${id} from=${to}`);
      return;
    }

    const reply = await runForAgent(currentAgent, buildCodexPrompt(message, body, history), { images, files });
    await sendText(account, to, reply, message.context_token);
    appendConversationTurn(account.accountId, to, body, reply);
    log(`replied to=${to} agent=${currentAgent.id} type=${currentAgent.type} chars=${reply.length}`);
  } catch (error) {
    warn(`failed processing message from=${to}: ${error.message}`);
    await sendText(account, to, `Agent 执行失败：${error.message}`, message.context_token);
  }
}

function requestBody(request, maxBytes) {
  return new Promise((resolve, reject) => {
    let raw = "";
    let size = 0;
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      size += Buffer.byteLength(chunk);
      if (size > maxBytes) {
        reject(new Error(`request body exceeds ${maxBytes} bytes`));
        request.destroy();
        return;
      }
      raw += chunk;
    });
    request.on("end", () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        reject(new Error("request body is not valid JSON"));
      }
    });
    request.on("error", reject);
  });
}

function writeAgentAttachments(attachments, dir, kind) {
  return (Array.isArray(attachments) ? attachments : []).flatMap((attachment, index) => {
    if (!attachment?.dataBase64) return [];
    const name = sanitizeFileName(attachment.name || `${kind}-${index}.bin`);
    const filePath = path.join(dir, `${kind}-${index}-${name}`);
    try {
      const buffer = Buffer.from(attachment.dataBase64, "base64");
      if (!buffer.length) return [];
      fs.writeFileSync(filePath, buffer, { flag: "wx" });
      return [filePath];
    } catch (error) {
      throw new Error(`cannot save ${kind} attachment ${name}: ${error.message}`);
    }
  });
}

async function executeAgentRequest(payload) {
  const jobDir = path.join(os.tmpdir(), `codex-weixin-agent-${randomUUID()}`);
  fs.mkdirSync(jobDir, { recursive: true });
  try {
    const imagePaths = writeAgentAttachments(payload.images, jobDir, "image");
    const filePaths = writeAgentAttachments(payload.files, jobDir, "file");
    const attachmentNotes = [
      ...imagePaths.map((filePath) => `远端图片: ${filePath}`),
      ...filePaths.map((filePath) => `远端文件: ${filePath}`),
    ];
    const prompt = attachmentNotes.length
      ? `${String(payload.prompt || "").trim()}\n\n${attachmentNotes.join("\n")}`
      : String(payload.prompt || "").trim();
    if (!prompt) throw new Error("prompt is empty");
    const timeoutMs = boundedNumber(
      agentEnv("TIMEOUT_MS"),
      DEFAULT_CODEX_TIMEOUT_MS,
      MIN_AGENT_TIMEOUT_MS,
      MAX_AGENT_TIMEOUT_MS,
    );
    return runLocalAgent(prompt, {
      images: imagePaths,
      files: filePaths,
      cwd: agentCwd(),
      model: agentEnv("MODEL") || undefined,
      approval: agentEnv("APPROVAL", "never"),
      sandbox: agentEnv("SANDBOX", "read-only"),
      timeoutMs,
    });
  } finally {
    fs.rmSync(jobDir, { recursive: true, force: true });
  }
}

function boundedNumber(value, fallback, min, max) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= min && parsed <= max ? parsed : fallback;
}

function validateRegistration(payload) {
  const id = String(payload.id || "").trim();
  if (!/^[a-zA-Z0-9_-]{1,32}$/.test(id) || id === "local") {
    throw new Error("client id must match [a-zA-Z0-9_-]{1,32} and cannot be local");
  }
  const executeUrl = String(payload.executeUrl || "").trim();
  let parsedUrl;
  try {
    parsedUrl = new URL(executeUrl);
  } catch {
    throw new Error("executeUrl must be a valid URL");
  }
  if (!["http:", "https:"].includes(parsedUrl.protocol) || parsedUrl.username || parsedUrl.password || parsedUrl.search || parsedUrl.hash) {
    throw new Error("executeUrl must use http/https without credentials, query, or fragment");
  }
  if (parsedUrl.pathname !== "/v1/execute") throw new Error("executeUrl path must be /v1/execute");
  const allowedHosts = String(process.env.WEIXIN_ALLOWED_CLIENT_HOSTS || "")
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
  if (allowedHosts.length && !allowedHosts.includes(parsedUrl.hostname.toLowerCase())) {
    throw new Error("executeUrl host is not allowed");
  }
  const clientToken = String(payload.clientToken || "").trim();
  if (clientToken.length < 32 || clientToken.length > 512) throw new Error("clientToken must be 32-512 characters");
  const label = String(payload.label || id).trim();
  if (!label || label.length > 80) throw new Error("label must be 1-80 characters");
  const cwd = String(payload.cwd || "").trim();
  if (cwd && (!path.isAbsolute(cwd) || cwd.length > 1024 || cwd.includes("\0"))) {
    throw new Error("cwd must be an absolute path up to 1024 characters");
  }
  const model = String(payload.model || "").trim();
  if (model.length > 128) throw new Error("model must be at most 128 characters");
  const agentType = String(payload.agentType || "codex").trim().toLowerCase();
  if (!AGENT_TYPES.includes(agentType)) throw new Error(`agentType must be one of: ${AGENT_TYPES.join(", ")}`);
  const requestedTimeout = Number(payload.timeoutMs || DEFAULT_AGENT_TIMEOUT_MS);
  if (!Number.isFinite(requestedTimeout) || requestedTimeout < MIN_AGENT_TIMEOUT_MS || requestedTimeout > MAX_AGENT_TIMEOUT_MS) {
    throw new Error(`timeoutMs must be ${MIN_AGENT_TIMEOUT_MS}-${MAX_AGENT_TIMEOUT_MS}`);
  }
  const timeoutMs = requestedTimeout;
  return { id, label, executeUrl: parsedUrl.toString(), clientToken, cwd, model, agentType, timeoutMs };
}

function metricsSnapshot(isServer) {
  const metrics = state.metrics;
  return {
    uptimeSeconds: Math.floor((Date.now() - metrics.startedAtMs) / 1000),
    httpRequests: metrics.httpRequests,
    executeRequests: metrics.executeRequests,
    executeSuccesses: metrics.executeSuccesses,
    executeFailures: metrics.executeFailures,
    executeTimeouts: metrics.executeTimeouts,
    averageExecuteMs: metrics.executeRequests ? Math.round(metrics.executeDurationMs / metrics.executeRequests) : 0,
    activeExecutions: state.activeChildren.size,
    registrations: metrics.registrations,
    heartbeats: metrics.heartbeats,
    pendingApprovals: listAccountIds().reduce((count, accountId) => count + Object.keys(loadPendingApprovals(accountId)).length, 0),
    agentExecutions: { ...metrics.agentExecutions },
    agentType: resolveAgentType(),
    ...(isServer ? { onlineClients: Object.keys(pruneClientsRegistry()).length } : {}),
  };
}

function authorized(request, tokens) {
  const accepted = Array.isArray(tokens) ? tokens : [tokens];
  return accepted.filter(Boolean).some((token) => request.headers.authorization === `Bearer ${token}`);
}

async function startHttpServer(mode) {
  const isServer = mode === "server";
  const token = isServer ? currentServerSecret() : currentClientToken();
  const executionTokens = isServer
    ? [token, process.env.WEIXIN_SERVER_NODE_TOKEN?.trim() || currentClientToken()]
    : [token];
  const host = (isServer ? process.env.WEIXIN_SERVER_HOST : process.env.WEIXIN_CLIENT_HOST)?.trim() || "127.0.0.1";
  const port = Number((isServer ? process.env.WEIXIN_SERVER_PORT : process.env.WEIXIN_CLIENT_PORT) || (isServer ? DEFAULT_SERVER_PORT : DEFAULT_CLIENT_PORT));
  const maxBytes = Number(process.env.WEIXIN_AGENT_BODY_MAX_BYTES || 64 * 1024 * 1024);
  const server = http.createServer(async (request, response) => {
    state.metrics.httpRequests += 1;
    const sendJson = (status, payload) => {
      response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
      response.end(JSON.stringify(payload));
    };
    if (request.method === "GET" && request.url === "/healthz") {
      sendJson(200, { ok: true });
      return;
    }
    if (request.method === "GET" && request.url === "/v1/metrics") {
      if (!authorized(request, executionTokens)) {
        sendJson(401, { error: "unauthorized" });
        return;
      }
      sendJson(200, metricsSnapshot(isServer));
      return;
    }
    if (isServer && request.method === "GET" && request.url === "/v1/clients") {
      if (!authorized(request, [token])) {
        sendJson(401, { error: "unauthorized" });
        return;
      }
      sendJson(200, { clients: Object.values(pruneClientsRegistry()) });
      return;
    }
    if (isServer && request.method === "POST" &&
      (request.url === "/v1/clients/register" || request.url === "/v1/clients/heartbeat")) {
      if (!authorized(request, [token])) {
        sendJson(401, { error: "unauthorized" });
        return;
      }
      try {
        const payload = await requestBody(request, maxBytes);
        const clients = readClientsRegistry();
        const id = String(payload.id || "").trim();
        const previous = clients[id] || {};
        if (request.url.endsWith("/register")) {
          const validated = validateRegistration(payload);
          clients[id] = { ...validated, lastSeenMs: Date.now(), lastSeen: new Date().toISOString() };
          state.metrics.registrations += 1;
        } else {
          if (!/^[a-zA-Z0-9_-]{1,32}$/.test(id) || !previous.id) {
            throw new Error("unknown client id; register first");
          }
          clients[id] = { ...previous, lastSeenMs: Date.now(), lastSeen: new Date().toISOString() };
          state.metrics.heartbeats += 1;
        }
        saveClientsRegistry(clients);
        sendJson(200, { ok: true, client: clients[id] });
      } catch (error) {
        sendJson(400, { error: error.message });
      }
      return;
    }
    if (request.method !== "POST" || request.url !== "/v1/execute") {
      sendJson(404, { error: "not found" });
      return;
    }
    if (!authorized(request, executionTokens)) {
      sendJson(401, { error: "unauthorized" });
      return;
    }
    state.metrics.executeRequests += 1;
    const executeStartedAt = Date.now();
    try {
      const payload = await requestBody(request, maxBytes);
      const text = await executeAgentRequest(payload);
      state.metrics.executeSuccesses += 1;
      sendJson(200, { text });
    } catch (error) {
      state.metrics.executeFailures += 1;
      if (/timed out/i.test(error.message)) state.metrics.executeTimeouts += 1;
      warn(`agent request failed: ${error.message}`);
      sendJson(500, { error: error.message });
    } finally {
      state.metrics.executeDurationMs += Date.now() - executeStartedAt;
    }
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, resolve);
  });
  log(`${mode} listening on http://${host}:${port}`);
  const stop = () => {
    state.stopping = true;
    server.close(async () => {
      await terminateAllChildren();
      process.exit(0);
    });
    setTimeout(async () => {
      await terminateAllChildren();
      process.exit(0);
    }, 5_000).unref();
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  if (isServer) {
    console.log(`server secret file: ${serverSecretPath()}`);
    if (process.env.WEIXIN_UPSTREAM_SERVER_URL?.trim() || process.env.WEIXIN_UPSTREAM_SERVER_HOSTNAME?.trim()) {
      registerUpstreamLoop().catch((error) => warn(`upstream registration stopped: ${error.message}`));
    }
    await new Promise(() => {});
  }
  await registerClientLoop();
}

function serverBaseUrl() {
  const explicit = process.env.WEIXIN_SERVER_URL?.trim();
  if (explicit) return explicit.replace(/\/+$/, "");
  const scheme = process.env.WEIXIN_SERVER_SCHEME?.trim() || "http";
  const host = process.env.WEIXIN_SERVER_HOSTNAME?.trim() || process.env.WEIXIN_SERVER_HOST?.trim() || "127.0.0.1";
  const port = Number(process.env.WEIXIN_SERVER_PORT || DEFAULT_SERVER_PORT);
  return `${scheme}://${host}:${port}`;
}

async function postBridgeJson(url, token, body) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Number(process.env.WEIXIN_AGENT_REGISTER_TIMEOUT_MS || 15_000));
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const raw = await response.text();
    const payload = raw ? JSON.parse(raw) : {};
    if (!response.ok || payload.error) throw new Error(payload.error || `HTTP ${response.status}`);
    return payload;
  } finally {
    clearTimeout(timeout);
  }
}

async function registerClientLoop() {
  const serverUrl = serverBaseUrl();
  const serverSecret = process.env.WEIXIN_SERVER_SECRET?.trim() ||
    readText(process.env.WEIXIN_SERVER_SECRET_FILE?.trim() || "").trim();
  if (!serverSecret) throw new Error("WEIXIN_SERVER_SECRET is required for client mode");
  const id = process.env.WEIXIN_CLIENT_ID?.trim() || os.hostname().replace(/[^a-zA-Z0-9_-]+/g, "-").slice(0, 32);
  const label = process.env.WEIXIN_CLIENT_LABEL?.trim() || id;
  const clientHost = process.env.WEIXIN_CLIENT_HOST?.trim() || "127.0.0.1";
  const clientPort = Number(process.env.WEIXIN_CLIENT_PORT || DEFAULT_CLIENT_PORT);
  const publicUrl = (process.env.WEIXIN_CLIENT_PUBLIC_URL?.trim() ||
    `http://${process.env.WEIXIN_CLIENT_ADVERTISE_HOST?.trim() || clientHost}:${clientPort}`).replace(/\/+$/, "");
  const agentType = resolveAgentType();
  const body = {
    id,
    label,
    executeUrl: `${publicUrl}/v1/execute`,
    clientToken: currentClientToken(),
    cwd: agentCwd(),
    model: agentEnv("MODEL"),
    agentType,
    timeoutMs: Number(agentEnv("TIMEOUT_MS", String(DEFAULT_CODEX_TIMEOUT_MS))),
  };
  const intervalMs = Number(process.env.WEIXIN_CLIENT_HEARTBEAT_MS || 30_000);
  while (true) {
    try {
      await postBridgeJson(`${serverUrl}/v1/clients/register`, serverSecret, body);
      log(`registered client=${id} agent_type=${agentType} server=${serverUrl}`);
      break;
    } catch (error) {
      warn(`client registration failed: ${error.message}`);
      await new Promise((resolve) => setTimeout(resolve, 5000));
    }
  }
  while (true) {
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
    try {
      await postBridgeJson(`${serverUrl}/v1/clients/heartbeat`, serverSecret, body);
    } catch (error) {
      warn(`client heartbeat failed: ${error.message}`);
    }
  }
}

function upstreamServerBaseUrl() {
  const explicit = process.env.WEIXIN_UPSTREAM_SERVER_URL?.trim();
  if (explicit) return explicit.replace(/\/+$/, "");
  const scheme = process.env.WEIXIN_UPSTREAM_SERVER_SCHEME?.trim() || "http";
  const host = process.env.WEIXIN_UPSTREAM_SERVER_HOSTNAME?.trim() || "127.0.0.1";
  const port = Number(process.env.WEIXIN_UPSTREAM_SERVER_PORT || DEFAULT_SERVER_PORT);
  return `${scheme}://${host}:${port}`;
}

async function registerUpstreamLoop() {
  const serverUrl = upstreamServerBaseUrl();
  const serverSecret = process.env.WEIXIN_UPSTREAM_SERVER_SECRET?.trim() ||
    readText(process.env.WEIXIN_UPSTREAM_SERVER_SECRET_FILE?.trim() || "").trim();
  if (!serverSecret) throw new Error("WEIXIN_UPSTREAM_SERVER_SECRET or _FILE is required");
  const id = process.env.WEIXIN_SERVER_NODE_ID?.trim() || os.hostname().replace(/[^a-zA-Z0-9_-]+/g, "-").slice(0, 32);
  const label = process.env.WEIXIN_SERVER_NODE_LABEL?.trim() || id;
  const publicUrl = (process.env.WEIXIN_SERVER_PUBLIC_URL?.trim() ||
    `http://${process.env.WEIXIN_SERVER_ADVERTISE_HOST?.trim() || process.env.WEIXIN_SERVER_HOSTNAME?.trim() || "127.0.0.1"}:${process.env.WEIXIN_SERVER_PORT || DEFAULT_SERVER_PORT}`).replace(/\/+$/, "");
  const agentType = resolveAgentType();
  const body = {
    id,
    label,
    executeUrl: `${publicUrl}/v1/execute`,
    clientToken: process.env.WEIXIN_SERVER_NODE_TOKEN?.trim() || currentClientToken(),
    cwd: agentCwd(),
    model: agentEnv("MODEL"),
    agentType,
    timeoutMs: Number(agentEnv("TIMEOUT_MS", String(DEFAULT_CODEX_TIMEOUT_MS))),
  };
  const intervalMs = Number(process.env.WEIXIN_UPSTREAM_HEARTBEAT_MS || 30_000);
  while (true) {
    try {
      await postBridgeJson(`${serverUrl}/v1/clients/register`, serverSecret, body);
      log(`registered server node=${id} upstream=${serverUrl}`);
      break;
    } catch (error) {
      warn(`upstream registration failed: ${error.message}`);
      await new Promise((resolve) => setTimeout(resolve, 5000));
    }
  }
  while (true) {
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
    try {
      await postBridgeJson(`${serverUrl}/v1/clients/heartbeat`, serverSecret, body);
    } catch (error) {
      warn(`upstream heartbeat failed: ${error.message}`);
    }
  }
}

async function pollOnce(account) {
  const previous = loadSyncBuf(account.accountId);
  const response = await getUpdates(account, previous);
  if (response.ret && response.ret !== 0) {
    throw new Error(`getupdates ret=${response.ret} errcode=${response.errcode || ""} ${response.errmsg || ""}`);
  }
  if (response.get_updates_buf != null && response.get_updates_buf !== "") {
    saveSyncBuf(account.accountId, response.get_updates_buf);
  }
  for (const message of response.msgs || []) {
    await processMessage(account, message);
  }
}

async function start() {
  const account = resolveAccount();
  acquireInstanceLock(account.accountId);
  log(`using account=${account.accountId} baseUrl=${account.baseUrl}`);

  process.on("SIGINT", () => {
    state.stopping = true;
  });
  process.on("SIGTERM", () => {
    state.stopping = true;
  });

  await notifyStart(account);
  try {
    while (!state.stopping) {
      try {
        await pollOnce(account);
      } catch (error) {
        warn(error.message);
        await new Promise((resolve) => setTimeout(resolve, 3000));
      }
    }
  } finally {
    await notifyStop(account);
    releaseInstanceLock();
  }
}

async function startServer() {
  await Promise.all([startHttpServer("server"), start()]);
}

async function main() {
  const command = process.argv[2] || "start";
  if (command === "login") return loginWeixin();
  if (command === "client" || command === "agent") return startHttpServer("client");
  if (command === "router" || command === "server" || command === "start") return startServer();
  if (command === "once") return pollOnce(resolveAccount());
  if (command === "accounts") {
    for (const id of listAccountIds()) console.log(id);
    return;
  }
  if (command === "executor") {
    const type = resolveAgentType();
    console.log(JSON.stringify({ type, binary: agentBinary(type), selection: process.env.WEIXIN_AGENT_TYPE?.trim() ? "explicit" : "detected" }));
    return;
  }
  if (command === "send") {
    const [, , , to, ...textParts] = process.argv;
    if (!to || textParts.length === 0) throw new Error("usage: codex-weixin-bridge send <to_user_id> <text>");
    return sendText(resolveAccount(), to, textParts.join(" "));
  }
  console.log(`usage: weixin-agent-bridge [login|server|client|once|accounts|executor|send]`);
}

main().catch((error) => {
  fail(error.message);
});
