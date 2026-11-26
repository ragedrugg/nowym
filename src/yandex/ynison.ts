/** Ynison — живое «сейчас играет» через JSON-over-WebSocket.
 *
 * Одноразовый сценарий: на каждый вызов открывает свежий ws (redirect→state),
 * берёт первый state-фрейм, резолвит playable_id в трек и закрывается. */

import {
  deviceIdFromToken,
  type Client as LibClient,
  YnisonClient,
  YnisonConnectionClosedError,
  YnisonDeviceDisplacedError,
  YnisonError,
  YnisonServerError,
  type YnisonState,
  YnisonUnauthorizedError,
} from "@dvxch/yandex-music";
import { sleep } from "../infra/async.ts";
import { getLogger } from "../infra/logging.ts";
import type { YaTrack } from "./types.ts";

const log = getLogger("yandex.ynison");

const RETRY_BACKOFF_MS = 500;
// ждём первый state-фрейм; client.ts оборачивает весь getCurrentTrack в 4с-таймаут.
const FIRST_STATE_TIMEOUT_MS = 3_000;
const REDIRECT_TIMEOUT_MS = 3_000;

/** результат get_current_track: трек + статус воспроизведения. */
export interface CurrentTrack {
  track: YaTrack | null;
  paused: boolean;
  duration_ms: number;
  progress_ms: number;
  entity_id: string | null;
  entity_type: string | null;
}

/** живой прогресс с учётом времени, прошедшего с последнего ts от ynison. */
export function liveProgressMs(
  progressMs: number,
  durationMs: number,
  paused: boolean,
  timestampMs: number,
  playbackSpeed = 1.0,
): number {
  if (paused || !timestampMs) return Math.max(0, progressMs);
  const elapsed = (Date.now() - timestampMs) * playbackSpeed;
  const progress = progressMs + elapsed;
  return Math.max(0, Math.min(progress, durationMs || progress));
}

/** тестовый шов: подмена эндпоинтов и паузы (без сети). */
export interface YnisonServiceOptions {
  redirectUrl?: string;
  stateUrl?: (host: string) => string;
  retryBackoffMs?: number;
}

/** стабильный id one-shot устройства: не засоряет список устройств аккаунта и
 * не совпадает с id долгоживущего наблюдателя (иначе они вытесняли бы друг друга). */
export function oneShotDeviceId(token: string): string {
  return deviceIdFromToken(`oneshot:${token}`);
}

/** ошибки, для которых повтор бессмысленен. */
function isTerminal(e: YnisonError): boolean {
  return (
    e instanceof YnisonUnauthorizedError ||
    e instanceof YnisonDeviceDisplacedError ||
    (e instanceof YnisonServerError && (e.goAwaySeconds ?? 0) > 0)
  );
}

export class YnisonService {
  private chain: Promise<void> = Promise.resolve();

  constructor(
    private lib: LibClient,
    private token: string,
    private opts: YnisonServiceOptions = {},
  ) {}

  /** один retry на транзиентный YnisonError. Не ретраим то, что повтор не лечит:
   * протухший токен (Unauthorized), вытеснение устройства (DeviceDisplaced) и
   * явный go-away сервера — эти ошибки отдаём сразу, с исходным сообщением.
   * реальный «не играет» (пустая очередь) сюда не падает — отдаёт валидный state. */
  private async getStateWithRetry(): Promise<YnisonState> {
    try {
      return await this.fetchFirstState();
    } catch (e) {
      if (!(e instanceof YnisonError) || isTerminal(e)) throw e;
      log.debug(`ynison первая попытка: ${e.message}, повтор`);
    }
    await sleep(this.opts.retryBackoffMs ?? RETRY_BACKOFF_MS);
    try {
      return await this.fetchFirstState();
    } catch (e) {
      if (e instanceof YnisonError && isTerminal(e)) throw e;
      throw new Error(`ynison недоступен: ${e instanceof Error ? e.message : e}`, { cause: e });
    }
  }

  /** одна ws-сессия: handshake → первый state-фрейм → закрытие.
   * Вызовы сериализуются: общий стабильный deviceId двух параллельных сессий
   * вытеснил бы одну из них (400090001). */
  private fetchFirstState(): Promise<YnisonState> {
    const run = this.chain.then(() => this.fetchFirstStateOnce());
    this.chain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async fetchFirstStateOnce(): Promise<YnisonState> {
    const client = new YnisonClient({
      token: this.token,
      deviceId: oneShotDeviceId(this.token),
      connectTimeoutMs: REDIRECT_TIMEOUT_MS,
      ...(this.opts.redirectUrl ? { redirectUrl: this.opts.redirectUrl } : {}),
      ...(this.opts.stateUrl ? { stateUrl: this.opts.stateUrl } : {}),
    });
    // connect() резолвится только при закрытии сессии, отклоняется при сбое handshake.
    // Закрытие до первого фрейма — тоже отказ; все промисы гасим от unhandled rejection.
    const connectFailed = client.connect(REDIRECT_TIMEOUT_MS).then(() => {
      throw new YnisonConnectionClosedError("ynison: сессия закрыта до первого state");
    });
    const first = client.waitFirstState(FIRST_STATE_TIMEOUT_MS);
    connectFailed.catch(() => {});
    first.catch(() => {});
    try {
      return await Promise.race([first, connectFailed]);
    } finally {
      // disconnect() синхронный (void, ждать нечего): сокет закрывается сам, а цепочка
      // сериализации держит следующую сессию до возврата отсюда
      client.disconnect();
    }
  }

  /** health-проверка транспорта: handshake redirect→state и первый state-фрейм.
   * В отличие от getCurrentTrack не требует играющего трека — пустая очередь
   * тоже валидный ответ. Без retry: панель должна отвечать быстро. */
  async probe(): Promise<{ ok: true; latencyMs: number; detail: string }> {
    const startedAt = Date.now();
    const state = await this.fetchFirstState();
    const latencyMs = Date.now() - startedAt;
    const queued = state.playableList.length;
    return {
      ok: true,
      latencyMs,
      detail: queued > 0 ? `state получен, очередь ${queued}` : "state получен, очередь пуста",
    };
  }

  /** {track, paused, duration_ms, progress_ms, entity_id, entity_type}.
   * бросает Error если ynison лёг или нет playable. */
  async getCurrentTrack(): Promise<CurrentTrack> {
    const state = await this.getStateWithRetry();

    const playableList = state.playableList;
    const idx = state.currentPlayableIndex;
    if (playableList.length === 0 || idx < 0 || idx >= playableList.length) {
      throw new Error("нет текущего трека");
    }

    const playableId = playableList[idx]!.playableId;
    if (!playableId) throw new Error("playable_id отсутствует");

    const tracks = (await this.lib.tracks([playableId])) as unknown as YaTrack[];
    const track = tracks.length > 0 ? tracks[0]! : null;

    return {
      track,
      paused: state.paused,
      duration_ms: state.durationMs,
      progress_ms: liveProgressMs(
        state.progressMs,
        state.durationMs,
        state.paused,
        state.timestampMs,
        state.playbackSpeed,
      ),
      entity_id: state.entityId,
      entity_type: state.entityType,
    };
  }
}
