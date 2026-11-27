/** Пул воркеров для рендера карточки.
 *
 * renderNowPlayingCard — CPU-bound canvas.encode(), ~50-100мс на кадр (1600x900).
 * Несмотря на async-сигнатуру, это синхронно блокирует весь event loop главного
 * потока — все остальные пользователи (inline-запросы, колбэки, вебхуки) ждут,
 * пока рендерится чья-то карточка. Вынос в worker_threads держит главный поток
 * свободным (gap event loop падает с ~100мс до ~6мс).
 *
 * Пул, а не воркер на запрос: холодный старт воркера (загрузка card.ts с canvas +
 * первая регистрация шрифтов) — сотни мс, что съело бы всю выгоду.
 *
 * R4: воркеры поднимаются лениво (на первом рендере) и гасятся после IDLE_MS
 * простоя — каждый держит свой V8-изолят + canvas + шрифты (десятки МБ RSS),
 * а карточки рендерятся редко. Холодный старт платит только первый рендер
 * после простоя. */
import { Worker } from "node:worker_threads";
import { getLogger } from "../infra/logging.ts";
import type { RenderCardArgs } from "./card.ts";

const log = getLogger("services.card_render_pool");

// нормальный рендер — 50-100мс; таймаут только чтобы не повесить весь пул
// навсегда, если воркер зависнет внутри нативного canvas.encode() без error/exit.
const RENDER_TIMEOUT_MS = 15_000;
// простой, после которого воркер гасится (следующий рендер поднимет заново)
const IDLE_MS = 10 * 60_000;

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
  idleTimer: ReturnType<typeof setTimeout> | null;
  // гасим сами (idle/таймаут/stop) — код выхода 1 штатный, не warning
  retiring: boolean;
}

export interface CardRenderPoolOptions {
  size?: number;
  idleMs?: number;
  workerUrl?: URL;
}

export class CardRenderPool {
  private workers: PoolWorker[] = [];
  private queue: PendingJob[] = [];
  private readonly size: number;
  private readonly idleMs: number;
  private readonly workerUrl: URL;
  private stopping = false;

  constructor(opts: CardRenderPoolOptions = {}) {
    this.size = Math.max(1, opts.size ?? 2);
    this.idleMs = opts.idleMs ?? IDLE_MS;
    this.workerUrl = opts.workerUrl ?? new URL("./cardRenderWorker.ts", import.meta.url);
  }

  /** число живых воркеров (для тестов и диагностики). */
  get workerCount(): number {
    return this.workers.length;
  }

  start(): void {
    this.stopping = false;
    log.info(
      `[card_pool] готов, до ${this.size} воркер(ов), ленивый старт, простой ${Math.round(this.idleMs / 1000)}с`,
    );
  }

  private spawn(): PoolWorker {
    const worker = new Worker(this.workerUrl);
    const pw: PoolWorker = { worker, busy: false, idleTimer: null, retiring: false };
    worker.on("error", (e) => {
      log.error(`[card_pool] воркер упал: ${e}`);
      // воркер мёртв — выкидываем; замену pump() поднимет лениво, если есть очередь.
      // Повторный error на том же воркере — filter() no-op, пул сверх size не растёт.
      this.retire(pw, false);
      this.pump();
    });
    worker.on("exit", (code) => {
      if (code !== 0 && !pw.retiring && !this.stopping) log.warning(`[card_pool] воркер завершился с кодом ${code}`);
      // вышел сам (не через retire) — убираем из пула, чтобы pump не слал ему джобы
      this.workers = this.workers.filter((w) => w !== pw);
    });
    return pw;
  }

  /** убрать воркер из пула; terminate=true — ещё и погасить поток. */
  private retire(pw: PoolWorker, terminate: boolean): void {
    pw.retiring = true;
    if (pw.idleTimer !== null) clearTimeout(pw.idleTimer);
    pw.idleTimer = null;
    this.workers = this.workers.filter((w) => w !== pw);
    if (terminate) void pw.worker.terminate();
  }

  private markIdle(pw: PoolWorker): void {
    pw.busy = false;
    if (pw.retiring) return;
    pw.idleTimer = setTimeout(() => {
      if (pw.busy) return;
      log.debug("[card_pool] воркер простаивал — гашу");
      this.retire(pw, true);
    }, this.idleMs);
    pw.idleTimer.unref?.();
  }

  async render(args: RenderCardArgs): Promise<Buffer> {
    if (this.stopping) throw new Error("card render pool stopped");
    return new Promise<Buffer>((resolve, reject) => {
      this.queue.push({ args, resolve, reject });
      this.pump();
    });
  }

  private pump(): void {
    if (this.queue.length === 0 || this.stopping) return;
    let idle = this.workers.find((w) => !w.busy);
    if (!idle) {
      if (this.workers.length >= this.size) return;
      idle = this.spawn();
      this.workers.push(idle);
    }
    const pw = idle;

    const job = this.queue.shift()!;
    pw.busy = true;
    if (pw.idleTimer !== null) clearTimeout(pw.idleTimer);
    pw.idleTimer = null;
    let settled = false;

    const onMessage = (msg: WorkerMsg): void => {
      if (settled) return;
      settled = true;
      cleanup();
      this.markIdle(pw);
      if (msg.ok) job.resolve(Buffer.from(msg.buf!.buffer, msg.buf!.byteOffset, msg.buf!.byteLength));
      else job.reject(new Error(msg.error ?? "card render failed"));
      this.pump(); // следующий в очереди, если есть
    };
    const onError = (e: Error): void => {
      if (settled) return;
      settled = true;
      cleanup();
      // обработчик error из spawn() уже выкинул воркера; здесь только отклоняем джоб
      job.reject(e);
      this.pump();
    };
    const onTimeout = (): void => {
      if (settled) return;
      settled = true;
      cleanup();
      log.error(`[card_pool] воркер завис (>${RENDER_TIMEOUT_MS}мс) — убиваю и поднимаю замену`);
      job.reject(new Error("card render timeout"));
      // зависший worker.terminate() надёжнее off/reuse — код внутри мог зациклиться;
      // замену pump() поднимет лениво
      this.retire(pw, true);
      this.pump();
    };
    const cleanup = (): void => {
      pw.worker.off("message", onMessage);
      pw.worker.off("error", onError);
      clearTimeout(timer);
    };

    const timer = setTimeout(onTimeout, RENDER_TIMEOUT_MS);
    pw.worker.on("message", onMessage);
    pw.worker.on("error", onError);
    pw.worker.postMessage(job.args);
  }

  async stop(): Promise<void> {
    this.stopping = true;
    for (const job of this.queue.splice(0)) job.reject(new Error("card render pool stopped"));
    const all = this.workers;
    for (const w of all) this.retire(w, false);
    await Promise.all(all.map((w) => w.worker.terminate()));
    log.info("[card_pool] остановлен");
  }
}
