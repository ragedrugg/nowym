/** OAuth Device Flow для яндекса. Опрашивает /token, при успехе сохраняет
 * access+refresh в БД (зашифрованно).
 *
 * транспорт — DeviceAuthMixin из @dvxch/yandex-music (requestDeviceCode/
 * pollDeviceToken/refreshAccessToken); Client допускает пустой token в
 * конструкторе, а device-эндпоинты на oauth.yandex.ru его не требуют.
 * client_id/secret берём из settings (по умолчанию — публичный клиент Android-
 * приложения Я.Музыки). */
import { DeviceAuthError, type DeviceCode, Client as LibClient, type OAuthToken } from "@dvxch/yandex-music";
import { sleep } from "../infra/async.ts";
import { getLogger } from "../infra/logging.ts";
import { getSettings } from "../settings.ts";
import type { UsersDb } from "../storage/users.ts";

const log = getLogger("auth");

const AUTH_TIMEOUT_SEC = 300; // 5 мин, даже если сервер даёт больше

export type OnSuccess = (userId: number) => void | Promise<void>;
export type OnFailure = (userId: number, reason: string) => void | Promise<void>;

export interface DeviceAuthState {
  userId: number;
  verificationUrl: string;
  userCode: string;
  expiresIn: number;
  /** завершается, когда poll-цикл закончился (успех/отказ/таймаут/отмена). */
  done: Promise<void>;
}

interface ActiveAuth {
  state: DeviceAuthState;
  cancelled: boolean;
}

/** транспортный срез Client'а, нужный для device-flow — внедряемый ради тестов
 * (фейк без реальных запросов на oauth.yandex.ru). */
export type DeviceAuthTransport = Pick<LibClient, "requestDeviceCode" | "pollDeviceToken" | "refreshAccessToken">;

export class AuthService {
  private active = new Map<number, ActiveAuth>();

  constructor(
    private usersDb: UsersDb,
    // без токена: только device-flow эндпоинты, не привязаны к аккаунту.
    private lib: DeviceAuthTransport = new LibClient(),
  ) {}

  /** запустить device flow. если уже идёт — отменит старую и стартанёт новую. */
  async startDeviceAuth(userId: number, onSuccess: OnSuccess, onFailure: OnFailure): Promise<DeviceAuthState | null> {
    const existing = this.active.get(userId);
    if (existing) {
      existing.cancelled = true;
      this.active.delete(userId);
    }

    const s = getSettings();
    let code: DeviceCode;
    try {
      code = await this.lib.requestDeviceCode(undefined, "мойва", s.YANDEX_OAUTH_CLIENT_ID);
      if (!code.deviceCode) {
        log.error(`device code не получен для ${userId}: пустой ответ`);
        return null;
      }
    } catch (e) {
      log.error(`device code не получен для ${userId}: ${e}`);
      return null;
    }

    const entry: ActiveAuth = {
      cancelled: false,
      state: {
        userId,
        verificationUrl: code.verificationUrl ?? "",
        userCode: code.userCode ?? "",
        expiresIn: Math.min(code.expiresIn ?? AUTH_TIMEOUT_SEC, AUTH_TIMEOUT_SEC),
        done: Promise.resolve(),
      },
    };
    // pollLoop может упасть на usersDb.save (БД моргнула в момент успешного
    // логина) — единственный путь, не обёрнутый в try/catch внутри pollLoop.
    // .done никто не awaitит, без catch это unhandledRejection, а юзер молча
    // зависает на экране «введи код» — зовём onFailure и тут, как во всех
    // остальных ветках отказа внутри pollLoop.
    entry.state.done = this.pollLoop(entry, code, onSuccess, onFailure).catch(async (e) => {
      log.error(`pollLoop упал для ${userId}: ${e}`);
      try {
        await onFailure(userId, "внутренняя ошибка, попробуй ещё раз");
      } catch {
        // ignore — мы и так уже в catch-ветке отказавшего pollLoop
      }
    });
    this.active.set(userId, entry);
    log.info(`device flow стартовал для ${userId}`);
    return entry.state;
  }

  cancelAuth(userId: number): boolean {
    const entry = this.active.get(userId);
    if (entry && !entry.cancelled) {
      entry.cancelled = true;
      this.active.delete(userId);
      return true;
    }
    return false;
  }

  isPending(userId: number): boolean {
    const entry = this.active.get(userId);
    return entry !== undefined && !entry.cancelled;
  }

  getState(userId: number): DeviceAuthState | null {
    return this.active.get(userId)?.state ?? null;
  }

  /** обновляет access через refresh (OAuth2 refresh grant), сохраняет в БД. */
  async refreshToken(userId: number, refreshToken: string): Promise<string | null> {
    const s = getSettings();
    try {
      const token = await this.lib.refreshAccessToken(
        refreshToken,
        s.YANDEX_OAUTH_CLIENT_ID,
        s.YANDEX_OAUTH_CLIENT_SECRET,
      );
      await this.usersDb.save(userId, token.accessToken!, token.refreshToken || refreshToken, token.expiresIn ?? null);
      log.info(`access обновлён для ${userId}`);
      return token.accessToken!;
    } catch (e) {
      log.warning(`refresh для ${userId} не сработал: ${e}`);
      return null;
    }
  }

  private async pollLoop(
    entry: ActiveAuth,
    code: DeviceCode,
    onSuccess: OnSuccess,
    onFailure: OnFailure,
  ): Promise<void> {
    const userId = entry.state.userId;
    const s = getSettings();
    const interval = Math.max(code.interval ?? 5, 3) * 1000;
    const deadline = Date.now() + entry.state.expiresIn * 1000;

    try {
      while (true) {
        await sleep(interval);
        if (entry.cancelled) {
          log.info(`авторизация отменена ${userId}`);
          return;
        }
        if (Date.now() >= deadline) {
          log.info(`таймаут авторизации ${userId}`);
          await onFailure(userId, "timeout");
          return;
        }

        // null = authorization_pending (юзер ещё не подтвердил) → опрашиваем дальше.
        // прочие ошибки (в т.ч. expired/denied) pollDeviceToken бросает — ловим ниже.
        let token: OAuthToken | null;
        try {
          token = await this.lib.pollDeviceToken(
            code.deviceCode!,
            s.YANDEX_OAUTH_CLIENT_ID,
            s.YANDEX_OAUTH_CLIENT_SECRET,
          );
        } catch (e) {
          const reason = e instanceof DeviceAuthError ? e.message : String(e);
          log.warning(`DeviceAuthError ${userId}: ${reason}`);
          await onFailure(userId, reason);
          return;
        }
        if (token === null) continue;

        await this.usersDb.save(userId, token.accessToken!, token.refreshToken ?? null, token.expiresIn ?? null);
        log.info(`авторизация ок для ${userId}`);
        await onSuccess(userId);
        return;
      }
    } finally {
      // снимаем только свою запись — параллельный start мог заменить новой
      if (this.active.get(userId) === entry) this.active.delete(userId);
    }
  }
}
