export async function encryptAesCbcForTest(keyBytes, ivBytes, plain) {
  const key = await crypto.subtle.importKey("raw", keyBytes, { name: "AES-CBC" }, false, [
    "encrypt",
  ]);
  const ct = await crypto.subtle.encrypt({ name: "AES-CBC", iv: ivBytes }, key, plain);
  return new Uint8Array(ct);
}
