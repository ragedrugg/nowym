import assert from "node:assert/strict";
import { mock, test } from "node:test";
import { schedulePeriodic } from "../src/infra/async.ts";

test("D6: schedulePeriodic — первый прогон через firstDelay, дальше по интервалу; stop гасит всё", () => {
  mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  try {
    let runs = 0;
    const stop = schedulePeriodic(
      () => {
        runs++;
      },
      5 * 60_000,
      24 * 3600_000,
    );
    mock.timers.tick(5 * 60_000 - 1);
    assert.equal(runs, 0);
    mock.timers.tick(1);
    assert.equal(runs, 1, "первый прогон через 5 мин, а не через сутки");
    mock.timers.tick(24 * 3600_000);
    assert.equal(runs, 2);
    stop();
    mock.timers.tick(48 * 3600_000);
    assert.equal(runs, 2, "после stop не срабатывает");
  } finally {
    mock.timers.reset();
  }
});

test("D6: schedulePeriodic — stop до первого прогона отменяет его", () => {
  mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  try {
    let runs = 0;
    const stop = schedulePeriodic(
      () => {
        runs++;
      },
      1000,
      5000,
    );
    stop();
    mock.timers.tick(10_000);
    assert.equal(runs, 0);
  } finally {
    mock.timers.reset();
  }
});
