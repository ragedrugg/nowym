/** M2 (review-1) + review-2 L4: install.sh и ecosystem.config.cjs отсекают node, который не умеет
 * запускать .ts встроенным type stripping по умолчанию (22.18+, 23.6+); порог единый — как
 * engines «^22.19 || >=23.6». */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import vm from "node:vm";

const root = path.resolve(import.meta.dirname, "..");

function loadEcosystem(nodeVersion: string): unknown {
  const code = readFileSync(path.join(root, "ecosystem.config.cjs"), "utf8");
  const module = { exports: {} as unknown };
  const fakeProcess = { versions: { node: nodeVersion }, execPath: "/usr/bin/node" };
  vm.runInNewContext(code, {
    module,
    require: (id: string) => (id === "node:path" ? path : undefined),
    __dirname: root,
    process: fakeProcess,
  });
  return module.exports;
}

const TOO_OLD = ["20.11.1", "22.0.0", "22.17.9", "22.18.0", "22.18.5", "23.0.0", "23.5.9"];
const OK = ["22.19.0", "22.21.1", "23.6.0", "23.11.0", "24.9.0", "24.18.0", "25.0.0"];

test("ecosystem.config.cjs бросает понятную ошибку на node < 22.19 и 23.0–23.5", () => {
  for (const v of TOO_OLD) {
    assert.throws(
      () => loadEcosystem(v),
      (e: Error) => e.message.includes(v) && e.message.includes(">= 22.19") && e.message.includes("23.6"),
      v,
    );
  }
});

test("ecosystem.config.cjs грузится на ^22.19 || >=23.6", () => {
  for (const v of OK) {
    const cfg = loadEcosystem(v) as { apps: { name: string }[] };
    assert.equal(cfg.apps[0]?.name, "nowym-ts", v);
  }
});

test("проверка версии в install.sh совпадает с engines (^22.19 || >=23.6)", () => {
  const sh = readFileSync(path.join(root, "install.sh"), "utf8");
  const m = sh.match(/if ! node -e '([^']+)'; then/);
  assert.ok(m?.[1], "в install.sh нет node -e проверки версии");
  const script = m[1];
  const engines = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")).engines.node;
  assert.equal(engines, "^22.19 || >=23.6");
  const run = (v: string): number => {
    let code = -1;
    vm.runInNewContext(script, {
      process: {
        versions: { node: v },
        exit: (c: number) => {
          code = c;
        },
      },
    });
    return code;
  };
  for (const v of TOO_OLD) assert.equal(run(v), 1, v);
  for (const v of OK) assert.equal(run(v), 0, v);
});
