// 账号选择、临期续期（DO 单飞）、失败冷却。
import { FAIL_COOLDOWN_SEC, REFRESH_AHEAD_SEC, refreshAccount } from "./qoder/client.js";
import { getAccount, listAccounts, updateAccount } from "./store.js";

// 随机起点避免多个 isolate 在冷启动时同时从 0 号账号起跑
let rr = Math.floor(Math.random() * 1_000_003);
let cache = { at: 0, rows: [] };
const CACHE_MS = 15000;

export async function loadAccounts(env, force = false) {
  const now = Date.now();
  if (!force && cache.rows.length && now - cache.at < CACHE_MS) return cache.rows;
  const rows = await listAccounts(env);
  cache = { at: now, rows };
  return rows;
}

export function invalidateAccounts() {
  cache = { at: 0, rows: [] };
}

function nowSec() {
  return Math.floor(Date.now() / 1000);
}

function isCooling(account, now) {
  return Boolean(account.failed_at && now - account.failed_at < FAIL_COOLDOWN_SEC);
}

export function accountUsable(account) {
  if (!account || !account.token) return false;
  if (account.refresh_dead && (!account.exp || account.exp <= nowSec())) return false;
  return true;
}

export async function candidateAccounts(env, excludeIds = new Set()) {
  const rows = (await loadAccounts(env, true)).filter(
    (a) => accountUsable(a) && !excludeIds.has(a.id)
  );
  if (!rows.length) return [];
  const now = nowSec();
  const healthy = rows.filter((a) => !isCooling(a, now));
  const pool = healthy.length ? healthy : rows;
  const start = rr++ % pool.length;
  return pool.slice(start).concat(pool.slice(0, start));
}

async function acquireLock(env, id) {
  if (!env.REFRESH_LOCK) return { ok: true, stub: null };
  const stub = env.REFRESH_LOCK.get(env.REFRESH_LOCK.idFromName(id));
  const resp = await stub.fetch("https://lock/acquire", { method: "POST" });
  const obj = await resp.json().catch(() => ({}));
  return { ok: resp.ok && obj.ok, stub };
}

async function releaseLock(stub) {
  if (!stub) return;
  try {
    await stub.fetch("https://lock/release", { method: "POST" });
  } catch {
    // 租约到期会自动释放
  }
}

// 临期账号续期。并发时由 DO 保证同账号只有一个刷新者；拿到锁后重读 KV，
// 若已被别的 isolate 刷新过就直接用新 token。
export async function ensureFresh(env, account) {
  const now = nowSec();
  if (!account.refresh_token || account.refresh_dead) return account;
  if (account.exp && account.exp - now > REFRESH_AHEAD_SEC) return account;

  const { ok, stub } = await acquireLock(env, account.id);
  if (!ok) {
    const latest = await getAccount(env, account.id);
    if (latest && latest.exp && latest.exp - now > REFRESH_AHEAD_SEC) return latest;
    return latest || account;
  }
  try {
    const latest = await getAccount(env, account.id);
    if (!latest) return account;
    if (latest.exp && latest.exp - now > REFRESH_AHEAD_SEC) return latest;
    const result = await refreshAccount(env, latest);
    const patch = result.patch || {};
    if (result.ok) {
      patch.last_refresh_at = nowSec();
      await updateAccount(env, latest.id, patch);
      invalidateAccounts();
      return { ...latest, ...patch };
    }
    if (result.dead) {
      await updateAccount(env, latest.id, patch);
      invalidateAccounts();
      return { ...latest, ...patch };
    }
    return latest;
  } finally {
    await releaseLock(stub);
  }
}

export async function markFailed(env, account, status) {
  const now = nowSec();
  await updateAccount(env, account.id, {
    failed_at: now,
    failed_status: status,
    exp: account.exp && account.exp > now ? account.exp : now - 1,
  });
  invalidateAccounts();
}

export async function refreshById(env, id) {
  const account = await getAccount(env, id);
  if (!account) return { ok: false, error: "账号不存在" };
  if (!account.refresh_token) return { ok: false, error: "没有 refresh_token" };
  const { ok, stub } = await acquireLock(env, id);
  if (!ok) return { ok: false, error: "该账号正在续期，请稍后重试" };
  try {
    const result = await refreshAccount(env, account);
    if (result.patch) {
      if (result.ok) result.patch.last_refresh_at = nowSec();
      await updateAccount(env, id, result.patch);
      invalidateAccounts();
    }
    return result;
  } finally {
    await releaseLock(stub);
  }
}
