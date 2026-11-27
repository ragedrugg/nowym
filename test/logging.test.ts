/** logging: D14 (LOG_LEVEL/LOG_FORMAT читаются при emit, а не на импорте logging.ts —
 * иначе значения из .env, который settings.ts грузит позже, игнорировались) и маскировка секретов. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { getLogger, maskSecrets } from "../src/infra/logging.ts";

function capture(fn: () => void): string {
  const out: string[] = [];
  const origOut = process.stdout.write;
  const origErr = process.stderr.write;
  const sink = ((chunk: string | Uint8Array) => {
    out.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  process.stdout.write = sink;
  process.stderr.write = sink;
  try {
    fn();
  } finally {
    process.stdout.write = origOut;
    process.stderr.write = origErr;
  }
  return out.join("");
}

test("D14: LOG_LEVEL, заданный после импорта логгера, применяется", () => {
  const log = getLogger("t.lazy");
  const prev = process.env.LOG_LEVEL;
  try {
    process.env.LOG_LEVEL = "ERROR";
    assert.equal(
      capture(() => log.info("hidden")),
      "",
    );
    process.env.LOG_LEVEL = "DEBUG";
    assert.match(
      capture(() => log.debug("shown")),
      /shown/,
    );
  } finally {
    if (prev === undefined) delete process.env.LOG_LEVEL;
    else process.env.LOG_LEVEL = prev;
  }
});

test("D14: LOG_FORMAT=json, заданный после импорта, применяется", () => {
  const log = getLogger("t.lazy");
  const prev = process.env.LOG_FORMAT;
  try {
    process.env.LOG_FORMAT = "json";
    const line = capture(() => log.warning("w"));
    assert.deepEqual({ level: JSON.parse(line).level, msg: JSON.parse(line).msg }, { level: "WARNING", msg: "w" });
  } finally {
    if (prev === undefined) delete process.env.LOG_FORMAT;
    else process.env.LOG_FORMAT = prev;
  }
});

test("маскировка: токен бота и OAuth-токен не попадают в лог", () => {
  const log = getLogger("t.mask");
  const line = capture(() =>
    log.error(
      "fetch https://api.telegram.org/bot123456:AAH-x_yZ/sendAudio failed; headers Authorization: OAuth y0_AgAA.bc-d",
    ),
  );
  assert.ok(!line.includes("AAH-x_yZ"), line);
  assert.ok(!line.includes("y0_AgAA.bc-d"), line);
  assert.match(line, /bot<token>\/sendAudio/);
  assert.match(line, /OAuth <token>/);
});

test("maskSecrets: обычный текст не меняется", () => {
  assert.equal(maskSecrets("track 42:13 about bots"), "track 42:13 about bots");
});
