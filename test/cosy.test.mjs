import test from "node:test";
import assert from "node:assert/strict";
import {
  CosyContext,
  bytesToB64,
  encodeBody,
  generateRuntimeAuthFields,
  md5Hex,
  rsaEncrypt,
  utf8,
  uuidHex,
} from "../src/qoder/cosy.js";

// 向量与 llm-proxy/test_qoder_cosy.py 完全一致（来自客户端 wasm 的确定性回放）。
const ENC_VECTORS = [
  ["", ""],
  ["A", "$p$p"],
  ["AA", "$aTp"],
  ["AAA", "dagp"],
  ["AAAA", "$$gdpppa"],
  ["AAAAA", "T$gdpapa"],
  ["AAAAAA", "gdgdpapa"],
  ["AAAAAAA", "pp$$pagdpagd"],
  ["AAAAAAAA", "paT$pagdpagd"],
  ["AB", "$aBp"],
  ["ABC", "RaKp"],
  ["ABCD", "$$KRC_pa"],
  ["ABCDE", "a$KRCTpa"],
  ["ABCDEF", "FHKRCTpa"],
  ["ABCDEFG", "Cf$$CTFHpaKR"],
  ["ABCDEFGH", "Cw&$CTFHpaKR"],
  ["hello", "q$FruHPH"],
  ["0123456789abcdef", "#(CLD&$$jMNIlSg*VRTYV^p."],
  [
    '{"session_id":"probe8","messages":[{"role":"user","content":"hi"}],"model_config":{"key":"qfmodel","source":"system"},"stream":true}',
    "n*NSDtu(CLuoBrBEjbJxKMD,ByBEjQNkCLu,KWGoK^JZKL#Sw*lECYJSFWK.N(FYB*f*#(WhJHFhJoByBOi)BE.JGoKtu(CLugWMu(QOPSN*lEr*P(FQBMmYK^Dxj^PSWhx(LzBMn*NZKb#OaIB*f*uSF^N(gEDxV*lLtXBEKbuHa*l*",
  ],
];

const AES_CASE = {
  key_hex: "31326432316634326164303634323232",
  iv_hex: "31326432316634326164303634323232",
  plain_hex:
    "7b22756964223a227531222c2273656375726974795f6f617574685f746f6b656e223a2264756d6d792d746f6b656e2d30313233343536373839222c226f7267616e697a6174696f6e5f6964223a226f726731222c226f7267616e697a6174696f6e5f74616773223a5b2261222c2262225d2c22646174615f706f6c6963795f616772656564223a747275657d",
  cipher_b64:
    "JBSFUtmbMnBpwjmwRCcEG4Ym/rqJoCavxkuYe27R5pgnC6IF6ePzJueX7qQb9KOkHJNLE8aYfx8z/POKSmXGfJ+L2tjplR4sLwBtA74yInqG0dBFsYaDfQzTB2Xme3jjaHfhCj3x9/o174vOM5s542B611Lmr2nOKw6S68O2jbqaOmwdLn9QdVlyvqRcx1K6",
};

const RSA_CASE = {
  m_hex: "31326432316634326164303634323232",
  uuid_raw_hex: "12d21f42ad0642220000000000000000",
  ps_hex:
    "2e60dd3f0fd6b1d6cece185ed212a9b117a94bb7aa7858c487d572d026b0334fc90b9adf8b304e2ba66584d41efe6d111d42fc9aa2bde125c6f79ddf0372b1a9579c22cbfcefa8db266c77c23f4d4ab8bed6fd106a55f7b42391b7b83d8302e785ae7a48e7a3056be86c690c24",
  key_b64:
    "dxc+2NyFhtyzjUVL74CdWiviflGq+uuW4cfS+VHBOukE1uz2G9Rf1VOYCQSCJXIT/QRNABiU8wMHmICZJ6qGDN2mowdxZYBuBWIZ+A6T7bIbLmJvtpTT6E3tCVzGkaQWdQFGLuk4jUTK3nAs5z7w0WFU78OKyeea8usMJvPk+jI=",
  info_b64:
    "JBSFUtmbMnBpwjmwRCcEG4Ym/rqJoCavxkuYe27R5pgnC6IF6ePzJueX7qQb9KOkHJNLE8aYfx8z/POKSmXGfJ+L2tjplR4sLwBtA74yInqG0dBFsYaDfQzTB2Xme3jjaHfhCj3x9/o174vOM5s542B611Lmr2nOKw6S68O2jbqaOmwdLn9QdVlyvqRcx1K6",
  plain:
    '{"uid":"u1","security_oauth_token":"dummy-token-0123456789","organization_id":"org1","organization_tags":["a","b"],"data_policy_agreed":true}',
};

const INFER_CASE = {
  uid: "u1",
  machine_id: "machine-id-xyz",
  cosy_version: "1.1.69",
  info:
    "7hMVP51IjbPUmiYMpVfyOUhzdx8i2ZmLIFsLRS1nZRI5Q0Oc7FW5MYPLTS9/O6P1QQ725Cy+Rv9ucdLXiHAqspa5MzJ99EQw8MHuaXUc1xrHwGE3IbH6TfwXNkCWVm1cqUT+Cqtr6rWpKDgntlDdoi3uPFikwziI/NQERdxcjapb08V5K3QXZ5Dy2xFV/Ual",
  key:
    "ARtAYQclUISlGmMAvTq9SE6jHyf1s+uGOvVqtzfdeQqGbRcfsi/hAUB3ke789pyA41MMZxFLcRMBU+jc8lo6gjfCj/wUU3lWrJOrgz2vjZzh3dhhd5iFaqVXu0ZCxZ+mKjLX7C0TVrJgCHtl+UJWkQvzRSCXpANSrbTiyB47t1E=",
  date: 1792203839,
  request_id: "1c756373-7805-45e0-9fff-a7e93b819104",
  endpoint: "https://gateway.qoder.com.cn",
  body:
    '{"session_id":"probe8","messages":[{"role":"user","content":"hi"}],"model_config":{"key":"qfmodel","source":"system"},"stream":true}',
  model: "qfmodel",
  source: "system",
  expect: {
    url:
      "https://gateway.qoder.com.cn/algo/api/v2/service/pro/sse/agent_chat_generation?FetchKeys=llm_model_result&AgentId=agent_common&Encode=1",
    body:
      "n*NSDtu(CLuoBrBEjbJxKMD,ByBEjQNkCLu,KWGoK^JZKL#Sw*lECYJSFWK.N(FYB*f*#(WhJHFhJoByBOi)BE.JGoKtu(CLugWMu(QOPSN*lEr*P(FQBMmYK^Dxj^PSWhx(LzBMn*NZKb#OaIB*f*uSF^N(gEDxV*lLtXBEKbuHa*l*",
    headers: {
      Accept: "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "Content-Type": "application/json",
      "Cosy-Business-Product": "cli",
      "Cosy-Business-Type": "agent",
      "Cosy-ClientType": "5",
      "Cosy-MachineId": "machine-id-xyz",
      "Cosy-MachineToken": "machine-id-xyz",
      "Cosy-MachineType": "5",
      "Cosy-Scene": "assistant",
      "Cosy-Version": "1.1.69",
      "Login-Version": "v2",
      "X-Model-Key": "qfmodel",
      "X-Model-Source": "system",
      Authorization:
        "Bearer COSY.eyJ2ZXJzaW9uIjoidjEiLCJyZXF1ZXN0SWQiOiIxYzc1NjM3My03ODA1LTQ1ZTAtOWZmZi1hN2U5M2I4MTkxMDQiLCJpbmZvIjoiN2hNVlA1MUlqYlBVbWlZTXBWZnlPVWh6ZHg4aTJabUxJRnNMUlMxblpSSTVRME9jN0ZXNU1ZUExUUzkvTzZQMVFRNzI1Q3krUnY5dWNkTFhpSEFxc3BhNU16Sjk5RVF3OE1IdWFYVWMxeHJId0dFM0liSDZUZndYTmtDV1ZtMWNxVVQrQ3F0cjZyV3BLRGdudGxEZG9pM3VQRmlrd3ppSS9OUUVSZHhjamFwYjA4VjVLM1FYWjVEeTJ4RlYvVWFsIiwiY29zeVZlcnNpb24iOiIxLjEuNjkiLCJpZGVWZXJzaW9uIjoiIn0=.96956fd1ad48755fba87b247a01f6598",
      "Cosy-Key":
        "ARtAYQclUISlGmMAvTq9SE6jHyf1s+uGOvVqtzfdeQqGbRcfsi/hAUB3ke789pyA41MMZxFLcRMBU+jc8lo6gjfCj/wUU3lWrJOrgz2vjZzh3dhhd5iFaqVXu0ZCxZ+mKjLX7C0TVrJgCHtl+UJWkQvzRSCXpANSrbTiyB47t1E=",
      "Cosy-User": "u1",
      "Cosy-Date": "1792203839",
      "Cosy-Data-Policy": "disagree",
    },
  },
};

const GET_CASE = {
  uid: "u1",
  machine_id: "machine-id-xyz",
  cosy_version: "1.1.69",
  info:
    "X9MygJUJcMf528oYRhmJSGipqzUufGSjmECdi1kibCfKQAM/P0zo+O99MUGnx8vgh1/7lVdWq2d6tJjxLQqLrg00fUizJ9+Tx3wz3bt4Hs95Vwa9JxHUenIWAzS1Mv6vWymVWoDlSSIiBgLdZpatzULYsAPW/qk1FnNX76Fz1SQa3M7tGWwV+kLj87ipn0Wj",
  key:
    "b21de+7WFC1o/1ZS23VXd1ZFsn/NYrJfwGnHn695RAZUd2ebWhYkWly4y4CjKsQyXb/5RHoif7OdegVqRpWzgKwnjM+PxlolFpdaivJM1b+8vUx3GIgIq+l2A5mJbjwdTyLKYOuvKFJaMhX8AU4ybnk8lpLnL1fUcvpwvMR6xcc=",
  date: 1792203859,
  request_id: "ae5b3acd-0068-404e-ad7c-31ba1be23a98",
  endpoint: "https://gateway.qoder.com.cn",
  path: "/api/v2/campaigns",
  policy: "disagree",
  expect: {
    url: "https://gateway.qoder.com.cn/algo/api/v2/campaigns",
    headers: {
      Accept: "application/json",
      "Accept-Encoding": "identity",
      Authorization:
        "Bearer COSY.eyJ2ZXJzaW9uIjoidjEiLCJyZXF1ZXN0SWQiOiJhZTViM2FjZC0wMDY4LTQwNGUtYWQ3Yy0zMWJhMWJlMjNhOTgiLCJpbmZvIjoiWDlNeWdKVUpjTWY1MjhvWVJobUpTR2lwcXpVdWZHU2ptRUNkaTFraWJDZktRQU0vUDB6bytPOTlNVUdueDh2Z2gxLzdsVmRXcTJkNnRKanhMUXFMcmcwMGZVaXpKOStUeDN3ejNidDRIczk1VndhOUp4SFVlbklXQXpTMU12NnZXeW1WV29EbFNTSWlCZ0xkWnBhdHpVTFlzQVBXL3FrMUZuTlg3NkZ6MVNRYTNNN3RHV3dWK2tMajg3aXBuMFdqIiwiY29zeVZlcnNpb24iOiIxLjEuNjkiLCJpZGVWZXJzaW9uIjoiIn0=.1ac46fba41b14843219f577e4f76c99a",
      "Content-Type": "application/json",
      "Cosy-Business-Product": "cli",
      "Cosy-Business-Type": "agent",
      "Cosy-ClientIp": "machine-id-xyz",
      "Cosy-ClientType": "5",
      "Cosy-Data-Policy": "disagree",
      "Cosy-Date": "1792203859",
      "Cosy-Key":
        "b21de+7WFC1o/1ZS23VXd1ZFsn/NYrJfwGnHn695RAZUd2ebWhYkWly4y4CjKsQyXb/5RHoif7OdegVqRpWzgKwnjM+PxlolFpdaivJM1b+8vUx3GIgIq+l2A5mJbjwdTyLKYOuvKFJaMhX8AU4ybnk8lpLnL1fUcvpwvMR6xcc=",
      "Cosy-MachineId": "machine-id-xyz",
      "Cosy-MachineToken": "machine-id-xyz",
      "Cosy-MachineType": "5",
      "Cosy-Scene": "assistant",
      "Cosy-User": "u1",
      "Cosy-Version": "1.1.69",
      "Login-Version": "v2",
    },
  },
};

function fieldsRng(rawUuidHex, psHex, total) {
  const stream = Buffer.concat([
    Buffer.from(rawUuidHex, "hex"),
    Buffer.from(psHex, "hex"),
    Buffer.alloc(total),
  ]);
  let pos = 0;
  return (n) => {
    const chunk = stream.subarray(pos, pos + n);
    pos += n;
    return new Uint8Array(chunk);
  };
}

function ctxOf(caseObj, fields, policy = "disagree") {
  return new CosyContext({
    uid: caseObj.uid,
    machineId: caseObj.machine_id,
    cosyVersion: caseObj.cosy_version,
    info: fields.encrypt_user_info,
    key: fields.key,
    dataPolicy: policy,
    clock: () => caseObj.date,
    rng: (n) =>
      n === 16
        ? new Uint8Array(
            caseObj.request_id
              .replace(/-/g, "")
              .match(/../g)
              .map((x) => parseInt(x, 16))
          )
        : new Uint8Array(n).fill(1),
  });
}

test("encoder matches wasm vectors", () => {
  for (const [plain, want] of ENC_VECTORS) {
    assert.equal(encodeBody(plain), want, JSON.stringify(plain));
  }
  assert.equal(encodeBody(new Uint8Array(0)), "");
  const raw = utf8("模型");
  assert.equal(encodeBody(raw).length, 4 * Math.ceil(raw.length / 3));
});

test("md5 matches standard vectors", () => {
  assert.equal(md5Hex(new Uint8Array(0)), "d41d8cd98f00b204e9800998ecf8427e");
  assert.equal(md5Hex(utf8("abc")), "900150983cd24fb0d6963f7d28e17f72");
  assert.equal(
    md5Hex(utf8("The quick brown fox jumps over the lazy dog")),
    "9e107d9d372bb6826bd81d3542a419d6"
  );
});

test("aes-128-cbc known answer", async () => {
  const key = Uint8Array.from(Buffer.from(AES_CASE.key_hex, "hex"));
  const iv = Uint8Array.from(Buffer.from(AES_CASE.iv_hex, "hex"));
  const plain = Uint8Array.from(Buffer.from(AES_CASE.plain_hex, "hex"));
  const { encryptAesCbcForTest } = await import("./helpers.mjs");
  const ct = await encryptAesCbcForTest(key, iv, plain);
  assert.equal(bytesToB64(ct), AES_CASE.cipher_b64);
});

test("rsa pkcs1 v1.5 known answer", () => {
  const m = Uint8Array.from(Buffer.from(RSA_CASE.m_hex, "hex"));
  const rng = fieldsRng("", RSA_CASE.ps_hex, 220);
  const got = bytesToB64(rsaEncrypt(m, rng));
  const ps = Buffer.from(RSA_CASE.ps_hex, "hex");
  const em = Buffer.concat([Buffer.from([0, 2]), ps, Buffer.from([0]), Buffer.from(m)]);
  const RSA_N = BigInt(
    "0x" +
      "c0f22307e5cd362e296bb04470f6de8fbf935ce24e8fcf511a0e2701329769c4" +
      "a76e499bb938036a52af1eaf818cf79a2600620e3ce87e371d2ca6d85803606a" +
      "1b3fa5e874643c9ed2db7e85673ef7227fca56e2e7c08f0927609bb896a9f24b" +
      "e1782099a66016a5bfdc3f1ff756bfc9e88d7b5dc5be30bf45a0223a00ebcecf"
  );
  let x = 0n;
  for (const b of em) x = (x << 8n) | BigInt(b);
  let c = 1n;
  let base = x % RSA_N;
  let e = 65537n;
  while (e > 0n) {
    if (e & 1n) c = (c * base) % RSA_N;
    base = (base * base) % RSA_N;
    e >>= 1n;
  }
  const want = Buffer.alloc(128);
  let y = c;
  for (let i = 127; i >= 0; i--) {
    want[i] = Number(y & 0xffn);
    y >>= 8n;
  }
  assert.equal(got, want.toString("base64"));
});

test("runtime auth fields replay", async () => {
  const rng = fieldsRng(RSA_CASE.uuid_raw_hex, RSA_CASE.ps_hex, 220);
  const fields = await generateRuntimeAuthFields(RSA_CASE.plain, rng);
  assert.equal(fields.key, RSA_CASE.key_b64);
  assert.equal(fields.encrypt_user_info, RSA_CASE.info_b64);
});

test("infer request exact", () => {
  const ctx = ctxOf(INFER_CASE, { encrypt_user_info: INFER_CASE.info, key: INFER_CASE.key });
  const got = ctx.prepareInferRequest(
    INFER_CASE.endpoint,
    INFER_CASE.body,
    INFER_CASE.model,
    INFER_CASE.source
  );
  assert.equal(got.url, INFER_CASE.expect.url);
  assert.equal(got.body, INFER_CASE.expect.body);
  assert.deepEqual(got.headers, INFER_CASE.expect.headers);
  assert.equal(uuidHex(new Uint8Array(16)), "00000000000040008000000000000000");
});

test("get request exact", () => {
  const ctx = ctxOf(GET_CASE, { encrypt_user_info: GET_CASE.info, key: GET_CASE.key });
  const got = ctx.prepareRequest(GET_CASE.endpoint, GET_CASE.path, { method: "GET" });
  assert.equal(got.url, GET_CASE.expect.url);
  assert.deepEqual(got.headers, GET_CASE.expect.headers);
  assert.equal("body" in got, false);
});

test("path forms and query handling", () => {
  const ctx = ctxOf(GET_CASE, { encrypt_user_info: GET_CASE.info, key: GET_CASE.key });
  const a = ctx.prepareRequest(GET_CASE.endpoint, "/api/v2/campaigns");
  const b = ctx.prepareRequest(GET_CASE.endpoint, "/algo/api/v2/campaigns");
  assert.deepEqual(a, b);
  const q1 = ctx.prepareRequest(GET_CASE.endpoint, "/api/v2/campaigns?x=1");
  const q2 = ctx.prepareRequest(GET_CASE.endpoint, "/api/v2/campaigns?x=2");
  assert.ok(q1.url.endsWith("?x=1"));
  assert.deepEqual(q1.headers, q2.headers);
});

test("policy flag and extra headers", () => {
  const ctx = ctxOf(GET_CASE, { encrypt_user_info: GET_CASE.info, key: GET_CASE.key }, "agree");
  const got = ctx.prepareRequest(GET_CASE.endpoint, GET_CASE.path, {
    extraHeaders: { "X-Test": "1" },
  });
  assert.equal(got.headers["Cosy-Data-Policy"], "agree");
  assert.equal(got.headers["X-Test"], "1");
});

test("fromAccount produces signable context", async () => {
  const ctx = await CosyContext.fromAccount({
    uid: "u1",
    token: "dummy",
    machineId: "mid",
    cosyVersion: "1.1.69",
    organizationId: "",
    organizationTags: [],
    dataPolicyAgreed: false,
  });
  const r = ctx.prepareRequest("https://api3.qoder.sh", "/api/v2/model/list");
  assert.ok(r.headers.Authorization.startsWith("Bearer COSY."));
  assert.equal(r.headers["Cosy-MachineId"], "mid");
  assert.equal(r.url, "https://api3.qoder.sh/algo/api/v2/model/list");
});
