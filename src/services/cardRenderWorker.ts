/** Воркер рендера карточки — снимает CPU-тяжёлый canvas.encode() (~50-100мс на
 * кадр, блокирует весь event loop) с основного потока. Один джоб за раз на воркер. */
import { parentPort } from "node:worker_threads";
import { type RenderCardArgs, renderNowPlayingCard } from "./card.ts";

if (!parentPort) throw new Error("cardRenderWorker должен запускаться как worker_thread");

parentPort.on("message", async (args: RenderCardArgs) => {
  try {
    const buf = await renderNowPlayingCard(args);
    parentPort!.postMessage({ ok: true, buf });
  } catch (e) {
    parentPort!.postMessage({ ok: false, error: e instanceof Error ? e.message : String(e) });
  }
});
