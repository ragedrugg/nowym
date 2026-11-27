import assert from "node:assert/strict";
import { test } from "node:test";
import { crypto, ENC_PREFIX } from "../src/infra/crypto.ts";

// Ключ и токен сгенерированы реальной cryptography.Fernet (Python) —
// доказывают byte-совместимость с прод-БД.
const PY_KEY = "nBC3b-psp0mnlKxJGvvw94zM-RdZZn0XRsH0r9o4tDQ=";
const PY_TOKEN =
  "enc:v1:gAAAAABqGJ1_nQNGUVCPUoPv5w1r--EUaQoLsfxXJq-8kp8EvK-t6XxS8Fim4RYBjVf5jfIdWRT_hhmP1qQKKXCn44z5tPFsvVYldx4_pE-7EZliK-wD9t0=";
const PY_PLAINTEXT = "o_test-access-token-12345";

test("расшифровывает токен, зашифрованный Python-Fernet", () => {
  crypto.init(PY_KEY);
  assert.equal(crypto.decrypt(PY_TOKEN), PY_PLAINTEXT);
});

test("round-trip encrypt → decrypt", () => {
  crypto.init(PY_KEY);
  const secret = "y0_AgAAAA...refresh-token";
  const enc = crypto.encrypt(secret);
  assert.ok(enc!.startsWith(ENC_PREFIX));
  assert.equal(crypto.decrypt(enc), secret);
});

test("legacy plaintext без префикса возвращается как есть", () => {
  crypto.init(PY_KEY);
  assert.equal(crypto.decrypt("plain-legacy-token"), "plain-legacy-token");
});

test("null проходит насквозь", () => {
  crypto.init(PY_KEY);
  assert.equal(crypto.encrypt(null), null);
  assert.equal(crypto.decrypt(null), null);
});

test("битый ключ → null, без исключения", () => {
  crypto.init("AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=");
  assert.equal(crypto.decrypt(PY_TOKEN), null);
});

test("D22: пустой ключ — подсказка с node-командой (как в .env.example), не Python", () => {
  assert.throws(
    () => crypto.init(""),
    (e: Error) =>
      e.message.includes(
        String.raw`node -e 'console.log(require("crypto").randomBytes(32).toString("base64").replace(/\+/g,"-").replace(/\//g,"_"))'`,
      ) && !/python/i.test(e.message),
  );
});

test("D22: ошибка расшифровки идёт через логгер, а не голый console.error", () => {
  crypto.init("AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=");
  const out: string[] = [];
  const orig = process.stderr.write;
  process.stderr.write = ((c: string | Uint8Array) => {
    out.push(String(c));
    return true;
  }) as typeof process.stderr.write;
  try {
    assert.equal(crypto.decrypt(PY_TOKEN), null);
  } finally {
    process.stderr.write = orig;
  }
  assert.match(out.join(""), /ERROR\s+\[infra\.crypto\] не расшифровать значение/);
});
