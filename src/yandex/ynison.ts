/** Ynison — живое «сейчас играет» через JSON-over-WebSocket.
 *
 * Одноразовый сценарий: на каждый вызов открывает свежий ws (redirect→state),
 * берёт первый state-фрейм, резолвит playable_id в трек и закрывается. */
import { getLogger } from "../infra/logging.ts";
import { sleep } from "../infra/async.ts";
import type { YaTrack } from "./types.ts";
import {
  Client as LibClient,
  YnisonClient,
  YnisonError,
  type YnisonState,
} from "@dvxch/yandex-music";

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

export class YnisonService {
  constructor(
    private lib: LibClient,
    private token: string,
  ) {}

  /** один retry на YnisonError — транзиентные ws-сбои.
   * реальный «не играет» (пустая очередь) сюда не падает — отдаёт валидный state. */
  private async getStateWithRetry(): Promise<YnisonState> {
    try {
      return await this.fetchFirstState();
    } catch (e) {
      if (!(e instanceof YnisonError)) throw e;
      log.debug(`ynison первая попытка: ${e.message}, повтор`);
    }
    await sleep(RETRY_BACKOFF_MS);
    try {
      return await this.fetchFirstState();
    } catch (e) {
      throw new Error(`ynison недоступен: ${e instanceof Error ? e.message : e}`);
    }
  }

  /** одна ws-сессия: handshake → первый state-фрейм → закрытие. */
  private async fetchFirstState(): Promise<YnisonState> {
    const client = new YnisonClient({ token: this.token });
    // connect() резолвится только при закрытии сессии — гоняем в фоне и читаем
    // его ошибку, чтобы не было «unhandled rejection» при обрыве handshake.
    const connectPromise = client.connect(REDIRECT_TIMEOUT_MS).catch((e: unknown) => {
      throw e instanceof Error ? e : new Error(String(e));
    });
    const first = client.waitFirstState(FIRST_STATE_TIMEOUT_MS);
    try {
      // что наступит раньше: первый фрейм или фатальный обрыв connect.
      return await Promise.race([first, connectPromise.then(() => first)]);
    } finally {
      await client.disconnect();
      // дочитываем connect, чтобы заглушить unhandled rejection после закрытия.
      void connectPromise.catch(() => {});
    }
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
