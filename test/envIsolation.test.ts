/** Изоляция тестов от боевого .env: settings.ts не читает .env при NODE_ENV=test. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const settingsUrl = new URL("../src/settings.ts", import.meta.url).href;

function probe(nodeEnv: string | undefined): string {
  const dir = mkdtempSync(join(tmpdir(), "nowym-envtest-"));
  try {
    writeFileSync(join(dir, ".env"), "NOWYM_ENV_SENTINEL=loaded\n");
    const env: NodeJS.ProcessEnv = { ...process.env };
    delete env.NOWYM_ENV_SENTINEL;
    if (nodeEnv === undefined) delete env.NODE_ENV;
    else env.NODE_ENV = nodeEnv;
    return execFileSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `await import(${JSON.stringify(settingsUrl)}); console.log(process.env.NOWYM_ENV_SENTINEL ?? "absent")`,
      ],
      { cwd: dir, env, encoding: "utf8" },
    ).trim();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("NODE_ENV=test: .env из cwd не загружается", () => {
  assert.equal(probe("test"), "absent");
});

test("обычный режим: .env из cwd загружается (поведение прода не изменилось)", () => {
  assert.equal(probe("production"), "loaded");
  assert.equal(probe(undefined), "loaded");
});

test("сам тестовый процесс идёт с NODE_ENV=test", () => {
  assert.equal(process.env.NODE_ENV, "test");
});
