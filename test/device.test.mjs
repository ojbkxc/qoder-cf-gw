// 设备身份：每个账号一套，请求头用各自那套，续期用签发时那台机器的身份。
import test from "node:test";
import assert from "node:assert/strict";
import { importAccounts, listAccounts } from "../src/store.js";
import { deviceHeaders, refreshAccount } from "../src/qoder/client.js";

function memoryKV() {
  const map = new Map();
  return {
    async get(key, type) {
      const value = map.get(key);
      if (value === undefined) return null;
      return type === "json" ? JSON.parse(value) : value;
    },
    async put(key, value) {
      map.set(key, String(value));
    },
    async delete(key) {
      map.delete(key);
    },
  };
}

test("导入：每号自己的设备身份与签发时的机器身份都落库", async () => {
  const env = { KV: memoryKV() };
  const res = await importAccounts(env, {
    accounts: [
      {
        token: "dt-1", uid: "u1", machineId: "mid-1", machineToken: "",
        machineType: "aaaaaaaaaaaaaaaaaa", machineCode: "bbbbbbbbbbbbbbbbbb",
        loginMachineId: "host-mid", loginMachineToken: "host-token",
      },
      { token: "dt-2", uid: "u2", machineId: "mid-2", machineType: "cccccccccccccccccc" },
    ],
  });
  assert.equal(res.imported, 2);
  const rows = await listAccounts(env);
  assert.deepEqual([...new Set(rows.map((r) => r.machine_id))].sort(), ["mid-1", "mid-2"]);
  const raw = await env.KV.get(`account:${rows[0].id}`, "json");
  assert.equal(raw.login_machine_id, "host-mid");
  assert.equal(raw.login_machine_token, "host-token");
  assert.equal(raw.machine_code, "bbbbbbbbbbbbbbbbbb");
});

test("设备头：用这个号自己那套指纹，不再共用一台机器", () => {
  const h = deviceHeaders({
    machine_id: "mid-1", machine_token: "", machine_type: "aaaaaaaaaaaaaaaaaa",
    machine_code: "bbbbbbbbbbbbbbbbbb",
  });
  assert.equal(h["Cosy-MachineId"], "mid-1");
  assert.equal(h["Cosy-MachineToken"], "mid-1");   // 没有独立 token 时退回 machineId
  assert.equal(h["Cosy-MachineType"], "aaaaaaaaaaaaaaaaaa");
  assert.equal(h["Cosy-MachineCode"], "bbbbbbbbbbbbbbbbbb");
});

test("续期：带的是签发 token 那台机器的身份", async () => {
  const bodies = [];
  const origFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    bodies.push(JSON.parse(init.body));
    return new Response(
      JSON.stringify({ device_token: "dt-new", refresh_token: "rt-new",
                       expires_at: "2099-01-01T00:00:00Z" }),
      { status: 200, headers: { "content-type": "application/json" } }
    );
  };
  try {
    const env = { KV: memoryKV() };
    const isolated = await refreshAccount(env, {
      id: "a1", token: "dt-old", refresh_token: "rt-old",
      machine_id: "mid-isolated", machine_token: "",
      login_machine_id: "host-mid", login_machine_token: "host-token",
    });
    assert.ok(isolated.ok, JSON.stringify(isolated));
    assert.equal(bodies[0].machine_id, "host-mid");
    assert.equal(bodies[0].machine_token, "host-token");

    const own = await refreshAccount(env, {
      id: "a2", token: "dt-old", refresh_token: "rt-old", machine_id: "mid-own",
    });
    assert.ok(own.ok, JSON.stringify(own));
    assert.equal(bodies[1].machine_id, "mid-own");
    assert.equal(bodies[1].machine_token, undefined);
  } finally {
    globalThis.fetch = origFetch;
  }
});
