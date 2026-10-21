// KV + DO 持久层：账号池、API Key、签到记录；用量走 UsageCounter DO。
import { parseExp } from "./qoder/client.js";

const K_ACCOUNTS = "accounts:index";
const kAccount = (id) => `account:${id}`;
const K_KEYS = "api_keys:index";
const kKey = (id) => `api_key:${id}`;
const kKeyHash = (hash) => `key_hash:${hash}`;
const kCheckins = (date) => `checkins:${date}`;

const ACCOUNT_FIELDS = new Set([
  "uid",
  "label",
  "token",
  "refresh_token",
  "expires_at",
  "refresh_expires_at",
  "exp",
  "display_name",
  "machine_id",
  "machine_token",
  "machine_type",
  "machine_code",
  "machine_hostname",
  "login_machine_id",
  "login_machine_token",
  "organization_id",
  "organization_tags",
  "data_policy_agreed",
  "cosy_version",
  "session_seed",
  "refresh_dead",
  "refresh_error",
  "failed_at",
  "failed_status",
  "last_refresh_at",
  "updated_at",
]);

async function getJson(env, key) {
  return env.KV.get(key, "json");
}

async function putJson(env, key, value) {
  await env.KV.put(key, JSON.stringify(value));
}

export async function listAccounts(env) {
  const ids = (await getJson(env, K_ACCOUNTS)) || [];
  if (!ids.length) return [];
  const rows = await Promise.all(ids.map((id) => getJson(env, kAccount(id))));
  return rows.filter(Boolean);
}

export async function getAccount(env, id) {
  return getJson(env, kAccount(id));
}

export async function updateAccount(env, id, patch) {
  const current = await getAccount(env, id);
  if (!current) return null;
  const next = { ...current };
  for (const [k, v] of Object.entries(patch)) {
    if (ACCOUNT_FIELDS.has(k)) next[k] = v;
  }
  next.updated_at = Math.floor(Date.now() / 1000);
  await putJson(env, kAccount(id), next);
  return next;
}

export function labelOf(raw) {
  const uidPart = "uid-" + String(raw.uid || "").slice(0, 8);
  const display = raw.display_name || raw.displayName || "";
  const base = raw.label || raw.account || uidPart;
  if (display && base === uidPart) return `${display} (${uidPart})`;
  return base || uidPart || "account";
}

export function normalizeAccount(raw) {
  const now = Math.floor(Date.now() / 1000);
  let tags = raw.organization_tags ?? raw.organizationTags ?? [];
  if (typeof tags === "string") {
    try {
      tags = JSON.parse(tags);
    } catch {
      tags = [];
    }
  }
  const exp = Number(raw.exp) || parseExp(raw.expires_at ?? raw.expiresAt) || 0;
  const uid = raw.uid || "";
  const display = raw.display_name || raw.displayName || "";
  const label = labelOf({ ...raw, uid, display_name: display });
  return {
    id: raw.id || crypto.randomUUID(),
    uid,
    label,
    token: raw.token || "",
    refresh_token: raw.refresh_token ?? raw.refreshToken ?? "",
    expires_at: raw.expires_at ?? raw.expiresAt ?? "",
    refresh_expires_at: raw.refresh_expires_at ?? raw.refreshTokenExpiresAt ?? "",
    exp,
    display_name: display,
    machine_id: raw.machine_id ?? raw.machineId ?? "",
    machine_token: raw.machine_token ?? raw.machineToken ?? "",
    machine_type: String(raw.machine_type ?? raw.machineType ?? ""),
    machine_code: raw.machine_code ?? raw.machineCode ?? "",
    machine_hostname: raw.machine_hostname ?? raw.machineHostname ?? "",
    login_machine_id: raw.login_machine_id ?? raw.loginMachineId ?? "",
    login_machine_token: raw.login_machine_token ?? raw.loginMachineToken ?? "",
    organization_id: raw.organization_id ?? raw.organizationId ?? "",
    organization_tags: JSON.stringify(Array.isArray(tags) ? tags : []),
    data_policy_agreed: (raw.data_policy_agreed ?? raw.dataPolicyAgreed) ? 1 : 0,
    cosy_version: raw.cosy_version ?? raw.cosyVersion ?? "1.1.69",
    session_seed: raw.session_seed ?? raw.sessionSeed ?? label,
    refresh_dead: raw.refresh_dead ? 1 : 0,
    refresh_error: raw.refresh_error || "",
    failed_at: Number(raw.failed_at) || 0,
    failed_status: Number(raw.failed_status) || 0,
    last_refresh_at: Number(raw.last_refresh_at) || 0,
    created_at: Number(raw.created_at) || now,
    updated_at: now,
  };
}

export async function importAccounts(env, payload) {
  const list = Array.isArray(payload)
    ? payload
    : Array.isArray(payload?.accounts)
      ? payload.accounts
      : payload && typeof payload === "object"
        ? [payload]
        : [];
  const out = { imported: 0, updated: 0, skipped: 0, items: [] };
  if (!list.length) return out;

  const existing = await listAccounts(env);
  const byUid = new Map(existing.filter((a) => a.uid).map((a) => [a.uid, a]));
  const ids = existing.map((a) => a.id);

  for (const raw of list) {
    if (!raw || typeof raw !== "object" || !raw.token) {
      out.skipped++;
      continue;
    }
    const acct = normalizeAccount(raw);
    const prev = acct.uid ? byUid.get(acct.uid) : null;
    if (prev) {
      const merged = {
        ...prev,
        ...acct,
        id: prev.id,
        created_at: prev.created_at,
        refresh_dead: acct.refresh_dead,
        failed_at: 0,
        failed_status: 0,
      };
      merged.label = acct.label || prev.label;
      await putJson(env, kAccount(prev.id), merged);
      byUid.set(acct.uid, merged);
      out.updated++;
      out.items.push({ label: merged.label, action: "updated" });
    } else {
      await putJson(env, kAccount(acct.id), acct);
      ids.push(acct.id);
      if (acct.uid) byUid.set(acct.uid, acct);
      out.imported++;
      out.items.push({ label: acct.label, action: "imported" });
    }
  }
  await putJson(env, K_ACCOUNTS, ids);
  return out;
}

export async function deleteAccountRecord(env, id) {
  await env.KV.delete(kAccount(id));
  const ids = ((await getJson(env, K_ACCOUNTS)) || []).filter((x) => x !== id);
  await putJson(env, K_ACCOUNTS, ids);
}

export function publicAccount(row) {
  return {
    id: row.id,
    label: row.label,
    uid: row.uid,
    display_name: row.display_name,
    expires_at: row.expires_at,
    refresh_expires_at: row.refresh_expires_at,
    exp: row.exp,
    has_refresh: Boolean(row.refresh_token),
    refresh_dead: Boolean(row.refresh_dead),
    refresh_error: row.refresh_error || "",
    failed_at: row.failed_at,
    failed_status: row.failed_status,
    machine_id: row.machine_id,
    machine_hostname: row.machine_hostname || "",
    last_refresh_at: row.last_refresh_at,
    organization_id: row.organization_id,
    data_policy_agreed: Boolean(row.data_policy_agreed),
  };
}

// ── API Key ─────────────────────────────────────────────────────────────────
async function sha256Hex(text) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (x) => x.toString(16).padStart(2, "0")).join("");
}

function normalizeExpiry(value) {
  if (value === null || value === undefined || value === "" || value === 0) return 0;
  let n = Number(value);
  if (!Number.isFinite(n)) {
    const parsed = Date.parse(String(value));
    n = Number.isFinite(parsed) ? Math.floor(parsed / 1000) : 0;
  } else {
    n = Math.floor(n);
    if (n > 1e12) n = Math.floor(n / 1000);
  }
  return n > 0 ? n : 0;
}

function normalizeMaxCalls(value) {
  const n = Math.floor(Number(value) || 0);
  return n > 0 ? n : 0;
}

function normalizeCustomKey(value) {
  if (value === undefined || value === null) return "";
  const key = String(value).trim();
  if (!key) return "";
  // 可见 ASCII 且无空格，避免粘贴时混入不可见字符导致客户端无法调用
  if (key.length < 8 || key.length > 200 || !/^[\x21-\x7e]+$/.test(key)) {
    throw Object.assign(
      new Error("自定义密钥需为 8-200 个可见 ASCII 字符，且不能包含空格"),
      { status: 400 }
    );
  }
  return key;
}

function keyPreview(value) {
  const key = String(value || "");
  if (key.length <= 6) return `${key.slice(0, 3)}...`;
  return `${key.slice(0, 5)}...${key.slice(-1)}`;
}

function keyIndexEntry(record) {
  return {
    id: record.id,
    name: record.name,
    created_at: record.created_at,
    last_used_at: record.last_used_at || 0,
    max_calls: Number(record.max_calls) || 0,
    expires_at: Number(record.expires_at) || 0,
    key_preview: keyPreview(record.key_value),
  };
}

function keyStub(env, id) {
  if (!env.KEY_COUNTER) return null;
  return env.KEY_COUNTER.get(env.KEY_COUNTER.idFromName(`key:${id}`));
}

async function keyUsed(env, id) {
  const stub = keyStub(env, id);
  if (!stub) return 0;
  try {
    const resp = await stub.fetch("https://key/get");
    if (!resp.ok) return 0;
    return Number((await resp.json()).used) || 0;
  } catch {
    return 0;
  }
}

export async function createApiKey(env, name, opts = {}) {
  const custom = normalizeCustomKey(opts.key);
  const raw = custom || "sk-" + Array.from(crypto.getRandomValues(new Uint8Array(24)), (x) =>
    x.toString(16).padStart(2, "0")
  ).join("");
  const id = crypto.randomUUID();
  const now = Math.floor(Date.now() / 1000);
  const hash = await sha256Hex(raw);
  if (await env.KV.get(kKeyHash(hash))) {
    throw Object.assign(new Error("该密钥值已被使用"), { status: 409 });
  }
  const record = {
    id,
    name: String(name || "default").slice(0, 80),
    key_value: raw,
    key_hash: hash,
    created_at: now,
    last_used_at: 0,
    enabled: 1,
    max_calls: normalizeMaxCalls(opts.max_calls),
    expires_at: normalizeExpiry(opts.expires_at),
  };
  await Promise.all([
    putJson(env, kKey(id), record),
    env.KV.put(kKeyHash(hash), id),
  ]);
  const index = (await getJson(env, K_KEYS)) || [];
  index.push(keyIndexEntry(record));
  await putJson(env, K_KEYS, index);
  return keyRow({ ...record, key_value: raw }, 0, now);
}

export async function listApiKeys(env) {
  const index = (await getJson(env, K_KEYS)) || [];
  const now = Math.floor(Date.now() / 1000);
  const rows = await Promise.all(
    index.map(async (entry) => {
      const record = await getJson(env, kKey(entry.id));
      if (!record) return null;
      return keyRow(record, await keyUsed(env, record.id), now, entry.key_preview);
    })
  );
  return rows.filter(Boolean);
}

function keyRow(record, used, now, previewFallback) {
  const ts = now || Math.floor(Date.now() / 1000);
  const max = Number(record.max_calls) || 0;
  const exp = Number(record.expires_at) || 0;
  return {
    id: record.id,
    name: record.name,
    key_value: record.key_value || "",
    key: record.key_value || "",
    key_preview: record.key_value ? keyPreview(record.key_value) : previewFallback || "",
    created_at: record.created_at,
    last_used_at: record.last_used_at || 0,
    max_calls: max,
    expires_at: exp,
    enabled: record.enabled ? 1 : 0,
    used_calls: used,
    remaining_calls: max > 0 ? Math.max(0, max - used) : null,
    remaining_days: exp > 0 ? (exp <= ts ? 0 : Math.ceil((exp - ts) / 86400)) : null,
  };
}

export async function updateApiKey(env, id, patch = {}) {
  const record = await getJson(env, kKey(id));
  if (!record) return null;
  const oldHash = record.key_hash;
  if (patch.name !== undefined) record.name = String(patch.name || "default").slice(0, 80);
  if (patch.expires_at !== undefined) record.expires_at = normalizeExpiry(patch.expires_at);
  if (patch.enabled !== undefined) record.enabled = patch.enabled ? 1 : 0;

  // 剩余次数口径：调用方填"还能用几次"，后端换算总量 = DO 真源已用 + 余量；0/空 = 不限
  if (patch.remaining_calls !== undefined) {
    const rem = Math.floor(Number(patch.remaining_calls) || 0);
    const used = await keyUsed(env, id);
    record.max_calls = rem > 0 ? used + rem : 0;
  } else if (patch.max_calls !== undefined) {
    record.max_calls = normalizeMaxCalls(patch.max_calls);
  }

  // 轮换热密钥：清旧 hash 索引，写新明文
  const rotated = normalizeCustomKey(patch.key_value ?? patch.key);
  if (rotated) {
    const hash = await sha256Hex(rotated);
    if (await env.KV.get(kKeyHash(hash))) {
      throw Object.assign(new Error("该密钥值已被使用"), { status: 409 });
    }
    if (oldHash && oldHash !== hash) await env.KV.delete(kKeyHash(oldHash));
    record.key_value = rotated;
    record.key_hash = hash;
    await env.KV.put(kKeyHash(hash), id);
  }

  await putJson(env, kKey(id), record);
  const index = (await getJson(env, K_KEYS)) || [];
  let found = false;
  const next = index.map((entry) => {
    if (entry.id !== id) return entry;
    found = true;
    return keyIndexEntry(record);
  });
  if (!found) next.push(keyIndexEntry(record));
  await putJson(env, K_KEYS, next);
  keyCache.clear();
  return keyRow(record, await keyUsed(env, id));
}

export async function deleteApiKey(env, id) {
  const record = await getJson(env, kKey(id));
  const jobs = [env.KV.delete(kKey(id))];
  if (record?.key_hash) jobs.push(env.KV.delete(kKeyHash(record.key_hash)));
  await Promise.all(jobs);
  const index = ((await getJson(env, K_KEYS)) || []).filter((k) => k.id !== id);
  await putJson(env, K_KEYS, index);
  keyCache.clear();
  const stub = keyStub(env, id);
  if (stub) await stub.fetch("https://key/reset", { method: "POST" }).catch(() => {});
}

export async function resetKeyUsage(env, id) {
  const stub = keyStub(env, id);
  if (!stub) return { ok: true, used: 0 };
  try {
    const resp = await stub.fetch("https://key/reset", { method: "POST" });
    return await resp.json();
  } catch {
    return { ok: false, used: 0 };
  }
}

const keyCache = new Map();

export async function verifyApiKey(env, key) {
  if (!key) return null;
  const hash = await sha256Hex(key);
  const cached = keyCache.get(hash);
  if (cached && cached.until > Date.now()) return cached.row;
  const id = await env.KV.get(kKeyHash(hash));
  if (!id) return null;
  const record = await getJson(env, kKey(id));
  if (!record || !record.enabled) return null;
  const row = {
    id: record.id,
    name: record.name,
    enabled: record.enabled,
    last_used_at: record.last_used_at,
    max_calls: Number(record.max_calls) || 0,
    expires_at: Number(record.expires_at) || 0,
    key_value: record.key_value || "",
  };
  keyCache.set(hash, { row, until: Date.now() + 60000 });
  return row;
}

export async function consumeKeyQuota(env, row) {
  const max = Number(row?.max_calls) || 0;
  const stub = row?.id ? keyStub(env, row.id) : null;
  if (!stub) return { ok: true, used: 0, max };
  try {
    const resp = await stub.fetch("https://key/check", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ max }),
    });
    if (!resp.ok) return { ok: true, used: 0, max };
    const data = await resp.json();
    return {
      ok: Boolean(data.ok),
      used: Number(data.used) || 0,
      max: Number(data.max) || max,
    };
  } catch {
    // 计数器不可用时放行，避免控制面故障拖垮数据面
    return { ok: true, used: 0, max };
  }
}

export async function touchApiKey() {
  // 最近使用时间不逐请求回写（KV 免费额度每天只有 1000 次写）。
}

// ── 用量（Durable Object）────────────────────────────────────────────────────
export function utcDate() {
  return new Date().toISOString().slice(0, 10);
}

function usageStub(env, date) {
  return env.USAGE_COUNTER.get(env.USAGE_COUNTER.idFromName(`usage:${date}`));
}

export async function recordUsage(env, usage) {
  if (!env.USAGE_COUNTER) return;
  const prompt = Number(usage?.prompt_tokens) || 0;
  const completion = Number(usage?.completion_tokens) || 0;
  const total = Number(usage?.total_tokens) || prompt + completion;
  if (!prompt && !completion && !total) return;
  try {
    await usageStub(env, utcDate()).fetch("https://usage/add", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ requests: 1, prompt, completion, total }),
    });
  } catch {
    // 用量统计失败不影响主流程
  }
}

async function usageOf(env, date) {
  if (!env.USAGE_COUNTER) return { date, requests: 0, total_tokens: 0 };
  try {
    const resp = await usageStub(env, date).fetch("https://usage/get");
    const data = await resp.json();
    return { date, ...data };
  } catch {
    return { date, requests: 0, total_tokens: 0 };
  }
}

export async function usageSummary(env) {
  const days = [];
  const now = Date.now();
  for (let i = 0; i < 7; i++) {
    days.push(new Date(now - i * 86400000).toISOString().slice(0, 10));
  }
  const rows = await Promise.all(days.map((d) => usageOf(env, d)));
  return { today: rows[0], trend: rows };
}

// ── 签到记录（KV，低频写）───────────────────────────────────────────────────
export async function latestCheckins(env) {
  const data = (await getJson(env, kCheckins(utcDate()))) || {};
  return Object.values(data).sort((a, b) => (b.updated_at || 0) - (a.updated_at || 0));
}

export async function saveCheckin(env, account, result) {
  const date = utcDate();
  const key = kCheckins(date);
  const data = (await getJson(env, key)) || {};
  const rep = result.rep || {};
  const amount = rep.claimed?.reduce((sum, c) => sum + (Number(c.amount) || 0), 0) || 0;
  data[account.id] = {
    date,
    account_id: account.id,
    label: account.label,
    status: result.ok ? "ok" : "failed",
    secured: rep.secured ? 1 : 0,
    amount,
    add_on_total: rep.addOnTotal ?? null,
    message: rep.message || rep.error || "",
    detail: JSON.stringify(rep).slice(0, 4000),
    updated_at: Math.floor(Date.now() / 1000),
  };
  await putJson(env, key, data);
}
