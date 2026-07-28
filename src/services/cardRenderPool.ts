/** Пул воркеров для рендера карточки.
 *
 * renderNowPlayingCard — CPU-bound canvas.encode(), ~50-100мс на кадр (1600x900).
 * Несмотря на async-сигнатуру, это синхронно блокирует весь event loop главного
 * потока — все остальные пользователи (inline-запросы, колбэки, вебхуки) ждут,
 * пока рендерится чья-то карточка. Вынос в worker_threads держит главный поток
 * свободным (gap event loop падает с ~100мс до ~6мс).
 *
 * Пул, а не воркер на запрос: холодный старт воркера (транспиляция card.ts под
 * tsx + первая регистрация шрифтов) — ~300мс, что съело бы всю выгоду. */
import { Worker } from "node:worker_threads";
import { getLogger } from "../infra/logging.ts";
import type { RenderCardArgs } from "./card.ts";

const log = getLogger("services.card_render_pool");

// нормальный рендер — 50-100мс; таймаут только чтобы не повесить весь пул
// навсегда, если воркер зависнет внутри нативного canvas.encode() без error/exit.
const RENDER_TIMEOUT_MS = 15_000;

interface WorkerMsg {
  ok: boolean;
  // structured clone через postMessage теряет Buffer-подкласс — на проводе это
  // всегда Uint8Array, реальный Buffer собираем в onMessage.
  buf?: Uint8Array;
  error?: string;
}

interface PendingJob {
  args: RenderCardArgs;
  resolve: (buf: Buffer) => void;
  reject: (e: Error) => void;
}

interface PoolWorker {
  worker: Worker;
  busy: boolean;
}

export class CardRenderPool {
  private workers: PoolWorker[] = [];
  private queue: PendingJob[] = [];
  private readonly size: number;
  private readonly workerUrl: URL;
  // worker.terminate() штатно завершает воркер с кодом 1 (не крах) — без этого
  // флага каждый рестарт бота писал в лог ложный WARNING.
  private stopping = false;

  constructor(size = 2) {
    this.size = Math.max(1, size);
    this.workerUrl = new URL("./cardRenderWorker.ts", import.meta.url);
  }

  start(): void {
    if (this.workers.length > 0) return;
    for (let i = 0; i < this.size; i++) this.workers.push(this.spawn());
    log.info(`[card_pool] запущен, ${this.size} воркер(а)`);
  }

  private spawn(): PoolWorker {
    const worker = new Worker(this.workerUrl);
    const pw: PoolWorker = { worker, busy: false };
    let replaced = false;
    worker.on("error", (e) => {
      log.error(`[card_pool] воркер упал: ${e}`);
      // второй error на том же воркере (ещё не exit'нувшем после первого) иначе
      // спавнил бы вторую замену — filter() на уже удалённом воркере no-op,
      // а push ниже выполнился бы всё равно, раздувая пул сверх size навсегда.
      if (replaced) return;
      replaced = true;
      // воркер мёртв — выкидываем и поднимаем замену, иначе пул со временем опустеет
      this.workers = this.workers.filter((w) => w !== pw);
      this.workers.push(this.spawn());
      this.pump();
    });
    worker.on("exit", (code) => {
      if (code !== 0 && !this.stopping) log.warning(`[card_pool] воркер завершился с кодом ${code}`);
    });
    return pw;
  }

  async render(args: RenderCardArgs): Promise<Buffer> {
    return new Promise<Buffer>((resolve, reject) => {
      this.queue.push({ args, resolve, reject });
      this.pump();
    });
  }

  private pump(): void {
    if (this.queue.length === 0) return;
    const idle = this.workers.find((w) => !w.busy);
    if (!idle) return;

    const job = this.queue.shift()!;
    idle.busy = true;
    let settled = false;

    const onMessage = (msg: WorkerMsg): void => {
      if (settled) return;
      settled = true;
      cleanup();
      idle.busy = false;
      if (msg.ok) job.resolve(Buffer.from(msg.buf!.buffer, msg.buf!.byteOffset, msg.buf!.byteLength));
      else job.reject(new Error(msg.error ?? "card render failed"));
      this.pump(); // следующий в очереди, если есть
    };
    const onError = (e: Error): void => {
      if (settled) return;
      settled = true;
      cleanup();
      // spawn() уже заменил воркера в this.workers; здесь только отклоняем джоб
      job.reject(e);
      this.pump();
    };
    const onTimeout = (): void => {
      if (settled) return;
      settled = true;
      cleanup();
      log.error(`[card_pool] воркер завис (>${RENDER_TIMEOUT_MS}мс) — убиваю и поднимаю замену`);
      job.reject(new Error("card render timeout"));
      // зависший worker.terminate() надёжнее off/reuse — код внутри мог зациклиться
      void idle.worker.terminate();
      this.workers = this.workers.filter((w) => w !== idle);
      this.workers.push(this.spawn());
      this.pump();
    };
    const cleanup = (): void => {
      idle.worker.off("message", onMessage);
      idle.worker.off("error", onError);
      clearTimeout(timer);
    };

    const timer = setTimeout(onTimeout, RENDER_TIMEOUT_MS);
    idle.worker.on("message", onMessage);
    idle.worker.on("error", onError);
    idle.worker.postMessage(job.args);
  }

  async stop(): Promise<void> {
    this.stopping = true;
    for (const job of this.queue.splice(0)) job.reject(new Error("card render pool stopped"));
    await Promise.all(this.workers.map((w) => w.worker.terminate()));
    this.workers = [];
    log.info("[card_pool] остановлен");
  }
}
