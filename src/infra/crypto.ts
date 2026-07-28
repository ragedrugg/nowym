/**
 * Шифрование секретов at-rest (Fernet: AES-128-CBC + HMAC-SHA256).
 *
 * Формат byte-совместим с cryptography.Fernet — обязательное условие, иначе
 * не прочитать уже сохранённые токены. Ключ из TOKEN_ENCRYPTION_KEY.
 * Префикс enc:v1: позволяет читать legacy plaintext-значения, не падая;
 * при следующей записи значение само станет зашифрованным.
 */
import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

export const ENC_PREFIX = "enc:v1:";

const FERNET_VERSION = 0x80;

/** urlsafe base64 С паддингом — как Python base64.urlsafe_b64encode. */
function b64urlEncode(buf: Buffer): string {
  return buf.toString("base64").replaceAll("+", "-").replaceAll("/", "_");
}

function b64urlDecode(s: string): Buffer {
  // base64url у Node терпит и urlsafe-алфавит, и отсутствие паддинга
  return Buffer.from(s, "base64url");
}

class FernetError extends Error {}

class Crypto {
  private signingKey: Buffer | null = null;
  private encryptionKey: Buffer | null = null;

  init(key: string): void {
    if (!key) {
      throw new Error(
        'TOKEN_ENCRYPTION_KEY пустой — сгенерируй: python -c "from ' +
          'cryptography.fernet import Fernet; print(Fernet.generate_key().decode())"',
      );
    }
    const raw = b64urlDecode(key);
    if (raw.length !== 32) {
      throw new Error(`TOKEN_ENCRYPTION_KEY: ожидалось 32 байта, получено ${raw.length}`);
    }
    this.signingKey = raw.subarray(0, 16);
    this.encryptionKey = raw.subarray(16, 32);
  }

  private ensureInit(): void {
    if (this.signingKey === null || this.encryptionKey === null) {
      throw new Error("crypto: init() не вызывался");
    }
  }

  encrypt(plaintext: string | null): string | null {
    if (plaintext === null) return null;
    this.ensureInit();
    return ENC_PREFIX + this.fernetEncrypt(Buffer.from(plaintext, "utf-8"));
  }

  /** legacy без префикса возвращаем как есть (plaintext до миграции). */
  decrypt(value: string | null): string | null {
    if (value === null) return null;
    if (!value.startsWith(ENC_PREFIX)) return value;
    this.ensureInit();
    try {
      const out = this.fernetDecrypt(value.slice(ENC_PREFIX.length));
      return out.toString("utf-8");
    } catch {
      // ключ сменился или токен бит — поведение как у Python (лог + None)
      console.error("[crypto] не расшифровать значение — ключ сменился?");
      return null;
    }
  }

  private fernetEncrypt(data: Buffer): string {
    const iv = randomBytes(16);
    const timestamp = Buffer.alloc(8);
    timestamp.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 1000)));

    const cipher = createCipheriv("aes-128-cbc", this.encryptionKey!, iv);
    const ciphertext = Buffer.concat([cipher.update(data), cipher.final()]);

    const basic = Buffer.concat([
      Buffer.from([FERNET_VERSION]),
      timestamp,
      iv,
      ciphertext,
    ]);
    const hmac = createHmac("sha256", this.signingKey!).update(basic).digest();
    return b64urlEncode(Buffer.concat([basic, hmac]));
  }

  private fernetDecrypt(token: string): Buffer {
    const data = b64urlDecode(token);
    if (data.length < 1 + 8 + 16 + 32 || data[0] !== FERNET_VERSION) {
      throw new FernetError("bad token");
    }
    const hmac = data.subarray(data.length - 32);
    const basic = data.subarray(0, data.length - 32);
    const expected = createHmac("sha256", this.signingKey!).update(basic).digest();
    if (hmac.length !== expected.length || !timingSafeEqual(hmac, expected)) {
      throw new FernetError("hmac mismatch");
    }
    const iv = data.subarray(9, 25);
    const ciphertext = data.subarray(25, data.length - 32);
    const decipher = createDecipheriv("aes-128-cbc", this.encryptionKey!, iv);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  }
}

export const crypto = new Crypto();
