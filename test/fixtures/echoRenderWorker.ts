/** Фейковый воркер рендера для cardRenderPool.test.ts: отвечает байтом из args.n. */
import { parentPort } from "node:worker_threads";

parentPort!.on("message", (args: { n: number; delayMs?: number }) => {
  setTimeout(() => parentPort!.postMessage({ ok: true, buf: new Uint8Array([args.n]) }), args.delayMs ?? 0);
});
