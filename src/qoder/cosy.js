// Cosy 签名协议：自定义 base64 / AES-128-CBC / RSA-1024 PKCS#1 v1.5 / MD5。
// 与 qoder_proxy.py 的实现逐字节对齐（test/cosy.test.mjs 用同一组向量）。

export const COSY_VERSION = "1.1.69";
export const DEFAULT_GATEWAY = "https://api3.qoder.sh";
export const DEFAULT_OPENAPI = "https://openapi.qoder.sh";
export const INFER_PATH = "/api/v2/service/pro/sse/agent_chat_generation";
export const INFER_QUERY = "FetchKeys=llm_model_result&AgentId=agent_common&Encode=1";

const RSA_N_HEX =
  "c0f22307e5cd362e296bb04470f6de8fbf935ce24e8fcf511a0e2701329769c4" +
  "a76e499bb938036a52af1eaf818cf79a2600620e3ce87e371d2ca6d85803606a" +
  "1b3fa5e874643c9ed2db7e85673ef7227fca56e2e7c08f0927609bb896a9f24b" +
  "e1782099a66016a5bfdc3f1ff756bfc9e88d7b5dc5be30bf45a0223a00ebcecf";
const RSA_N = BigInt("0x" + RSA_N_HEX);
const RSA_E = 65537n;
const RSA_LEN = 128;
const AES_KEY_LEN = 16;

const ALPHABET = new Uint8Array(
  Array.from("_doRTgHZBKcGVjlvpC,@aFSx#DPuNJme&i*MzLOEn)sUrthbf%Y^w.(kIQyXqWA!", (c) =>
    c.charCodeAt(0)
  )
);
const BODY_PAD = 0x24;

const UTF8_ENCODER = new TextEncoder();
const UTF8_DECODER = new TextDecoder();

export function utf8(s) {
  return UTF8_ENCODER.encode(s);
}

export function bytesToB64(bytes) {
  const b64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i];
    const b = i + 1 < bytes.length ? bytes[i + 1] : 0;
    const c = i + 2 < bytes.length ? bytes[i + 2] : 0;
    out += b64[a >> 2];
    out += b64[((a & 3) << 4) | (b >> 4)];
    out += i + 1 < bytes.length ? b64[((b & 15) << 2) | (c >> 6)] : "=";
    out += i + 2 < bytes.length ? b64[c & 63] : "=";
  }
  return out;
}

function b64Custom(data) {
  const n = data.length;
  const out = [];
  const full = n - (n % 3);
  for (let i = 0; i < full; i += 3) {
    const c0 = data[i];
    const c1 = data[i + 1];
    const c2 = data[i + 2];
    out.push(ALPHABET[c0 >> 2]);
    out.push(ALPHABET[((c0 & 3) << 4) | (c1 >> 4)]);
    out.push(ALPHABET[((c1 & 15) << 2) | (c2 >> 6)]);
    out.push(ALPHABET[c2 & 63]);
  }
  const rem = n - full;
  if (rem === 1) {
    const c0 = data[full];
    out.push(ALPHABET[c0 >> 2], ALPHABET[(c0 & 3) << 4], BODY_PAD, BODY_PAD);
  } else if (rem === 2) {
    const c0 = data[full];
    const c1 = data[full + 1];
    out.push(
      ALPHABET[c0 >> 2],
      ALPHABET[((c0 & 3) << 4) | (c1 >> 4)],
      ALPHABET[(c1 & 15) << 2],
      BODY_PAD
    );
  }
  return Uint8Array.from(out);
}

function reorder(raw) {
  const n = raw.length;
  if (n === 0) return raw;
  const a = Math.floor(n / 3);
  const b = n - a;
  const out = new Uint8Array(n);
  out.set(raw.subarray(b), 0);
  out.set(raw.subarray(a, b), n - b);
  out.set(raw.subarray(0, a), n - a);
  return out;
}

export function encodeBody(data) {
  const bytes = typeof data === "string" ? utf8(data) : data;
  return UTF8_DECODER.decode(reorder(b64Custom(bytes)));
}

// ── MD5（Web Crypto 不提供）──────────────────────────────────────────────────
const MD5_S = [
  7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 5, 9, 14, 20, 5, 9, 14, 20,
  5, 9, 14, 20, 5, 9, 14, 20, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
  6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
];
const MD5_K = new Uint32Array([
  0xd76aa478, 0xe8c7b756, 0x242070db, 0xc1bdceee, 0xf57c0faf, 0x4787c62a, 0xa8304613,
  0xfd469501, 0x698098d8, 0x8b44f7af, 0xffff5bb1, 0x895cd7be, 0x6b901122, 0xfd987193,
  0xa679438e, 0x49b40821, 0xf61e2562, 0xc040b340, 0x265e5a51, 0xe9b6c7aa, 0xd62f105d,
  0x02441453, 0xd8a1e681, 0xe7d3fbc8, 0x21e1cde6, 0xc33707d6, 0xf4d50d87, 0x455a14ed,
  0xa9e3e905, 0xfcefa3f8, 0x676f02d9, 0x8d2a4c8a, 0xfffa3942, 0x8771f681, 0x6d9d6122,
  0xfde5380c, 0xa4beea44, 0x4bdecfa9, 0xf6bb4b60, 0xbebfbc70, 0x289b7ec6, 0xeaa127fa,
  0xd4ef3085, 0x04881d05, 0xd9d4d039, 0xe6db99e5, 0x1fa27cf8, 0xc4ac5665, 0xf4292244,
  0x432aff97, 0xab9423a7, 0xfc93a039, 0x655b59c3, 0x8f0ccc92, 0xffeff47d, 0x85845dd1,
  0x6fa87e4f, 0xfe2ce6e0, 0xa3014314, 0x4e0811a1, 0xf7537e82, 0xbd3af235, 0x2ad7d2bb,
  0xeb86d391,
]);

function rotl(x, n) {
  return ((x << n) | (x >>> (32 - n))) >>> 0;
}

export function md5Hex(bytes) {
  const bitLen = bytes.length * 8;
  const padded = new Uint8Array((((bytes.length + 8) >>> 6) + 1) << 6);
  padded.set(bytes);
  padded[bytes.length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(padded.length - 8, bitLen >>> 0, true);
  view.setUint32(padded.length - 4, Math.floor(bitLen / 0x100000000) >>> 0, true);

  let a0 = 0x67452301;
  let b0 = 0xefcdab89;
  let c0 = 0x98badcfe;
  let d0 = 0x10325476;
  const M = new Uint32Array(16);

  for (let off = 0; off < padded.length; off += 64) {
    for (let i = 0; i < 16; i++) M[i] = view.getUint32(off + i * 4, true);
    let A = a0;
    let B = b0;
    let C = c0;
    let D = d0;
    for (let i = 0; i < 64; i++) {
      let F;
      let g;
      if (i < 16) {
        F = (B & C) | (~B & D);
        g = i;
      } else if (i < 32) {
        F = (D & B) | (~D & C);
        g = (5 * i + 1) % 16;
      } else if (i < 48) {
        F = B ^ C ^ D;
        g = (3 * i + 5) % 16;
      } else {
        F = C ^ (B | ~D);
        g = (7 * i) % 16;
      }
      F = (F + A + MD5_K[i] + M[g]) >>> 0;
      A = D;
      D = C;
      C = B;
      B = (B + rotl(F, MD5_S[i])) >>> 0;
    }
    a0 = (a0 + A) >>> 0;
    b0 = (b0 + B) >>> 0;
    c0 = (c0 + C) >>> 0;
    d0 = (d0 + D) >>> 0;
  }

  let hex = "";
  for (const word of [a0, b0, c0, d0]) {
    for (let i = 0; i < 4; i++) {
      hex += ((word >>> (i * 8)) & 0xff).toString(16).padStart(2, "0");
    }
  }
  return hex;
}

// ── RSA PKCS#1 v1.5（只做公钥加密）──────────────────────────────────────────
function bytesToBigInt(bytes) {
  let x = 0n;
  for (const b of bytes) x = (x << 8n) | BigInt(b);
  return x;
}

export function modPow(base, exp, mod) {
  let result = 1n;
  let b = base % mod;
  let e = exp;
  while (e > 0n) {
    if (e & 1n) result = (result * b) % mod;
    b = (b * b) % mod;
    e >>= 1n;
  }
  return result;
}

export function rsaEncrypt(msg, rng = secureRandom) {
  const psLen = RSA_LEN - msg.length - 3;
  if (psLen < 8) throw new Error("RSA 明文过长");
  const ps = [];
  while (ps.length < psLen) {
    for (const b of rng(psLen * 2)) {
      if (b !== 0 && ps.length < psLen) ps.push(b);
    }
  }
  const em = new Uint8Array(RSA_LEN);
  em[1] = 0x02;
  em.set(ps, 2);
  em[2 + psLen] = 0x00;
  em.set(msg, 3 + psLen);
  const c = modPow(bytesToBigInt(em), RSA_E, RSA_N);
  const out = new Uint8Array(RSA_LEN);
  let x = c;
  for (let i = RSA_LEN - 1; i >= 0; i--) {
    out[i] = Number(x & 0xffn);
    x >>= 8n;
  }
  return out;
}

// ── UUID / 随机数 ────────────────────────────────────────────────────────────
export function secureRandom(n) {
  const out = new Uint8Array(n);
  crypto.getRandomValues(out);
  return out;
}

function bytesToHex(b) {
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}

function formatUuid(b) {
  const h = bytesToHex(b);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

function applyUuidBits(raw, version) {
  const b = Uint8Array.from(raw);
  b[6] = (b[6] & 0x0f) | (version << 4);
  b[8] = (b[8] & 0x3f) | 0x80;
  return b;
}

export function uuidHex(raw) {
  return bytesToHex(applyUuidBits(raw, 4));
}

export function uuidString(raw) {
  return formatUuid(applyUuidBits(raw, 4));
}

export function randomUuid() {
  return uuidString(secureRandom(16));
}

const NAMESPACE_URL = new Uint8Array([
  0x6b, 0xa7, 0xb8, 0x11, 0x9d, 0xad, 0x11, 0xd1, 0x80, 0xb4, 0x00, 0xc0, 0x4f, 0xd4, 0x30,
  0xc8,
]);

export function uuidV5(name, namespaceBytes = NAMESPACE_URL) {
  const hash = md5Bytes(concatBytes(namespaceBytes, utf8(name)));
  return formatUuid(applyUuidBits(hash, 5));
}

function concatBytes(a, b) {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

function md5Bytes(bytes) {
  const hex = md5Hex(bytes);
  const out = new Uint8Array(16);
  for (let i = 0; i < 16; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

// ── 账号加密字段（AES 密钥 = RSA 密文里的 UUID 前 16 位）──────────────────────
async function aesCbcEncrypt(keyBytes, ivBytes, plain) {
  const key = await crypto.subtle.importKey("raw", keyBytes, { name: "AES-CBC" }, false, [
    "encrypt",
  ]);
  const ct = await crypto.subtle.encrypt({ name: "AES-CBC", iv: ivBytes }, key, plain);
  return new Uint8Array(ct);
}

export function accountJsonOf(auth) {
  return JSON.stringify({
    uid: auth.uid || "",
    security_oauth_token: auth.token || "",
    organization_id: auth.organizationId || "",
    organization_tags: auth.organizationTags || [],
    data_policy_agreed: Boolean(auth.dataPolicyAgreed),
  });
}

export async function generateRuntimeAuthFields(accountJson, rng = secureRandom) {
  const raw = typeof accountJson === "string" ? utf8(accountJson) : accountJson;
  const m = utf8(uuidHex(rng(16)).slice(0, 16));
  const key = bytesToB64(rsaEncrypt(m, rng));
  const info = bytesToB64(await aesCbcEncrypt(m, m, raw));
  return { encrypt_user_info: info, key };
}

// ── COSY 上下文 ──────────────────────────────────────────────────────────────
function normPath(path) {
  let p = path || "/";
  let q = "";
  const idx = p.indexOf("?");
  if (idx >= 0) {
    q = p.slice(idx + 1);
    p = p.slice(0, idx);
  }
  if (p.startsWith("/algo/")) p = p.slice(5);
  else if (p === "/algo") p = "/";
  return [p, q];
}

export class CosyContext {
  constructor({ uid, machineId, cosyVersion, info, key, dataPolicy, rng, clock } = {}) {
    this.uid = uid || "";
    this.machineId = machineId || "";
    this.cosyVersion = cosyVersion || COSY_VERSION;
    this.info = info;
    this.key = key;
    this.dataPolicy = dataPolicy || "disagree";
    this.rng = rng || secureRandom;
    this.clock = clock || (() => Math.floor(Date.now() / 1000));
  }

  static async fromAccount(auth, opts = {}) {
    const fields = await generateRuntimeAuthFields(accountJsonOf(auth), opts.rng);
    return new CosyContext({
      uid: auth.uid,
      machineId: auth.machineId,
      cosyVersion: auth.cosyVersion,
      info: fields.encrypt_user_info,
      key: fields.key,
      dataPolicy: auth.dataPolicyAgreed ? "agree" : "disagree",
      rng: opts.rng,
      clock: opts.clock,
    });
  }

  sign(path, bodyLine) {
    const date = String(Math.trunc(this.clock()));
    const rid = uuidString(this.rng(16));
    const part0 = JSON.stringify({
      version: "v1",
      requestId: rid,
      info: this.info,
      cosyVersion: this.cosyVersion,
      ideVersion: "",
    });
    const p0 = bytesToB64(utf8(part0));
    const pre = [p0, this.key, date, bodyLine, path].join("\n");
    const sig = md5Hex(utf8(pre));
    return { p0, sig, date };
  }

  baseHeaders() {
    return {
      "Cosy-User": this.uid,
      "Cosy-Key": this.key,
      "Cosy-MachineId": this.machineId,
      "Cosy-MachineToken": this.machineId,
      "Cosy-MachineType": "5",
      "Cosy-ClientType": "5",
      "Cosy-Business-Product": "cli",
      "Cosy-Business-Type": "agent",
      "Cosy-Scene": "assistant",
      "Cosy-Version": this.cosyVersion,
      "Login-Version": "v2",
      "Cosy-Data-Policy": this.dataPolicy,
      "Content-Type": "application/json",
    };
  }

  prepareInferRequest(endpoint, body, model, source) {
    const text = typeof body === "string" ? body : JSON.stringify(body);
    const encoded = encodeBody(text);
    const path = INFER_PATH;
    const { p0, sig, date } = this.sign(path, encoded);
    const headers = this.baseHeaders();
    Object.assign(headers, {
      Accept: "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Model-Key": model,
      "X-Model-Source": source,
      "Cosy-Date": date,
      Authorization: `Bearer COSY.${p0}.${sig}`,
    });
    const base = (endpoint || DEFAULT_GATEWAY).replace(/\/+$/, "");
    return {
      url: `${base}/algo${path}?${INFER_QUERY}`,
      headers,
      body: encoded,
    };
  }

  prepareRequest(endpoint, path, { method = "GET", body = null, extraHeaders = null } = {}) {
    const [rel, query] = normPath(path);
    const text = body === null ? null : typeof body === "string" ? body : JSON.stringify(body);
    const encoded = text === null ? "" : encodeBody(text);
    const { p0, sig, date } = this.sign(rel, encoded);
    const headers = this.baseHeaders();
    Object.assign(headers, {
      Accept: "application/json",
      "Accept-Encoding": "identity",
      "Cosy-ClientIp": this.machineId,
    });
    headers["Cosy-Date"] = date;
    headers.Authorization = `Bearer COSY.${p0}.${sig}`;
    if (extraHeaders) {
      for (const [k, v] of Object.entries(extraHeaders)) headers[String(k)] = String(v);
    }
    let url = `${(endpoint || DEFAULT_GATEWAY).replace(/\/+$/, "")}/algo${rel}`;
    if (query) url += `?${query}`;
    const out = { url, headers, method };
    if (text !== null) out.body = encoded;
    return out;
  }
}
