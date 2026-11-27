/** HTTP-клиент с пулом на undici.
 *
 * два режима:
 *  - request()      — общий keep-alive пул для обложек, api, retrieve;
 *  - downloadAudio() — свежее TCP-соединение на каждый запрос (без keepalive),
 *    CDN яндекса из EU иногда виснет на keepalive. */
import { Agent, type Dispatcher, interceptors, request } from "undici";
import { getSettings } from "../settings.ts";
import { sleep } from "./async.ts";
import { getLogger } from "./logging.ts";

const log = getLogger("infra.http");

const HEADERS_TIMEOUT = 10_000;
const BODY_TIMEOUT = 20_000;
// connect короткий намеренно: зависший узел CDN иначе съедает полный таймаут
// на каждой из racing-попыток одновременно, умножая задержку показа трека
const AUDIO_CONNECT_TIMEOUT = 4_000;
const AUDIO_BODY_TIMEOUT = 15_000;

const BROWSER_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36";

export interface HttpResponse {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: Dispatcher.ResponseData["body"];
}

/** тело больше лимита (по content-length или по факту чтения) — ретраить бессмысленно. */
export class ResponseTooLargeError extends Error {
  constructor(bytes: number, limit: number) {
    super(`ответ ${bytes} байт > лимит ${limit}`);
    this.name = "ResponseTooLargeError";
  }
}

/** читает тело, обрывая его, как только набралось больше maxBytes. */
async function readBodyLimited(body: Dispatcher.ResponseData["body"], maxBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of body as AsyncIterable<Buffer>) {
    total += chunk.length;
    if (total > maxBytes) {
      body.destroy();
      throw new ResponseTooLargeError(total, maxBytes);
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, total);
}

export class HttpClient {
  private agent: Agent | null = null;

  private getAgent(): Agent {
    if (this.agent === null) {
      const s = getSettings();
      this.agent = new Agent({
        connections: s.HTTP_LIMIT_PER_HOST,
        keepAliveTimeout: 15_000,
        keepAliveMaxTimeout: 60_000,
        connect: { timeout: HEADERS_TIMEOUT },
        headersTimeout: HEADERS_TIMEOUT,
        bodyTimeout: BODY_TIMEOUT,
      });
      log.info("http клиент инициализирован");
    }
    return this.agent;
  }

  /** общий пул: GET/POST через keep-alive. Заголовки мёржатся с дефолтным UA. */
  async request(
    url: string,
    opts: {
      method?: Dispatcher.HttpMethod;
      headers?: Record<string, string>;
      body?: string | Buffer;
    } = {},
  ): Promise<HttpResponse> {
    const res = await request(url, {
      method: opts.method ?? "GET",
      headers: { "User-Agent": BROWSER_UA, ...opts.headers },
      body: opts.body,
      dispatcher: this.getAgent(),
    });
    return { status: res.statusCode, headers: res.headers, body: res.body };
  }

  /** Лёгкая проверка доступности ресурса без скачивания тела (для health/CDN probe).
   * Пытается HEAD, при неуспехе/405 — GET с Range bytes=start-end. */
  async headOrRange(url: string, start = 0, end = 0): Promise<{ status: number } | null> {
    try {
      const head = await request(url, {
        method: "HEAD",
        headers: { "User-Agent": BROWSER_UA },
        dispatcher: this.getAgent(),
      });
      await head.body.dump();
      if (head.statusCode < 400 && head.statusCode !== 405) return { status: head.statusCode };
    } catch {
      /* fall through to range */
    }
    try {
      const res = await request(url, {
        method: "GET",
        headers: { "User-Agent": BROWSER_UA, Range: `bytes=${start}-${end}` },
        dispatcher: this.getAgent(),
      });
      await res.body.dump();
      return { status: res.statusCode };
    } catch {
      return null;
    }
  }

  /** скачать аудио: свежий agent (force_close) на каждую попытку + ретраи.
   * signal — для racing-загрузки: отменяет проигравшие попытки.
   * maxBytes (R8): content-length больше лимита — отказ до чтения тела, без
   * ретраев; без content-length тело обрывается, как только перевалит лимит. */
  async downloadAudio(
    url: string,
    maxRetries = 3,
    signal?: AbortSignal,
    maxBytes = Number.POSITIVE_INFINITY,
  ): Promise<Buffer> {
    let lastError: unknown = null;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      if (signal?.aborted) throw new Error("aborted");
      // CDN яндекса отдаёт 308 на прямую ссылку → редирект на хранилище;
      // undici не следует редиректам без явного интерсептора на диспетчере.
      const agent = new Agent({
        pipelining: 0,
        connections: 1,
        connect: { timeout: AUDIO_CONNECT_TIMEOUT },
        headersTimeout: AUDIO_CONNECT_TIMEOUT,
        bodyTimeout: AUDIO_BODY_TIMEOUT,
      }).compose(interceptors.redirect({ maxRedirections: 5 }));
      try {
        const res = await request(url, {
          method: "GET",
          headers: { "User-Agent": BROWSER_UA },
          dispatcher: agent,
          signal,
        });
        if (res.statusCode !== 200) {
          // дочитываем тело, чтобы соединение освободилось
          await res.body.dump();
          throw new Error(`HTTP ${res.statusCode}`);
        }
        const declared = Number(res.headers["content-length"]);
        if (Number.isFinite(declared) && declared > maxBytes) {
          res.body.destroy();
          throw new ResponseTooLargeError(declared, maxBytes);
        }
        const data = await readBodyLimited(res.body, maxBytes);
        if (attempt > 1) {
          log.info(`аудио скачано ${(data.length / 1024).toFixed(1)} KB (попытка ${attempt}/${maxRetries})`);
        } else {
          log.debug(`аудио скачано ${(data.length / 1024).toFixed(1)} KB`);
        }
        return data;
      } catch (e) {
        if (e instanceof ResponseTooLargeError) throw e;
        lastError = e;
        // отмена извне (проигравшая racing-попытка) — штатно, не warning
        if (signal?.aborted) {
          log.debug(`аудио: попытка отменена (${attempt}/${maxRetries})`);
          throw e;
        }
        log.warning(`ошибка аудио (попытка ${attempt}/${maxRetries}): ${e}`);
        if (attempt < maxRetries) {
          const delay = attempt * 3000 + Math.random() * 2000;
          await sleep(delay, signal); // signal: отменённая racing-попытка не спит зря весь бэкофф
        }
      } finally {
        await agent.close().catch(() => {});
      }
    }

    throw new Error(`не вышло скачать аудио за ${maxRetries} попыток: ${lastError}`);
  }

  async close(): Promise<void> {
    if (this.agent !== null) {
      await this.agent.close();
      this.agent = null;
      log.info("http клиент закрыт");
    }
  }
}
