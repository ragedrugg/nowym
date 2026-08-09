/** Spotify OAuth Authorization Code + PKCE.
 *
 * Гибридный флоу:
 *   • Если задан WEBHOOK_HOST — редирект Spotify летит на
 *     <WEBHOOK_HOST>/spotify/callback, main.ts ловит его, авторизация
 *     завершается сама, юзер видит «готово» в чате.
 *   • Иначе — paste-код: юзер открывает ссылку, авторизуется, попадает на
 *     любой redirect_uri (мы используем http://127.0.0.1:8888/callback),
 *     копирует `code=` из адресной строки и присылает боту.
 *
 * Токены (access + refresh) шифруются at-rest в UsersDb. */

import { randomBytes, createHash } from "node:crypto";
import { HttpClient } from "../infra/http.ts";
import { getLogger } from "../infra/logging.ts";
import { getSettings } from "../settings.ts";
import type { UsersDb } from "../storage/users.ts";

const log = getLogger("auth");

const SPOTIFY_AUTH = "https://accounts.spotify.com";
// Права: чтение метаданных пользователя + плеера, лайки/сохранённые.
// user-library-modify нужен для setTrackLiked, user-read-currently-playing —
// для карточки «сейчас играет», user-read-recently-played — для inline «недавнее».
export const SPOTIFY_SCOPES = [
  "user-read-private",
  "user-read-email",
  "user-read-playback-state",
  "user-read-currently-playing",
  "user-read-recently-played",
  "user-library-read",
  "user-library-modify",
].join(" ");

const AUTH_TIMEOUT_SEC = 600; // 10 минут — юзеру нужно время открыть браузер

export type OnSuccess = (userId: number) => void | Promise<void>;
export type OnFailure = (userId: number, reason: string) => void | Promise<void>;

export interface DeviceAuthState {
  userId: number;
  verificationUrl: string;
  /** state — рандом, привязывающий OAuth-редирект к юзеру (в базе-мапе). */
  state: string;
  /** для paste-режима — короткий текст, что вставлять; для webhook-режима пустой. */
  userCode: string;
  expiresIn: number;
  /** true = webhook доедет сам; false = юзеру надо прислать код. */
  usesCallback: boolean;
  /** резолвится, когда авторизация завершилась (ок/отказ/таймаут/отмена). */
  done: Promise<void>;
}

interface ActiveAuth {
  state: DeviceAuthState;
  cancelled: boolean;
  pkceVerifier: string;
  resolveDone: () => void;
  onSuccess: OnSuccess;
  onFailure: OnFailure;
  deadline: number;
}

function base64url(buf: Buffer): string {
  return buf.toString("base64").replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

function makePkcePair(): { verifier: string; challenge: string } {
  const verifier = base64url(randomBytes(32));
  const challenge = base64url(createHash("sha256").update(verifier).digest());
  return { verifier, challenge };
}

interface SpotifyTokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  token_type?: string;
  scope?: string;
}

export class AuthService {
  private active = new Map<number, ActiveAuth>();
  // state → userId — mainhttp-callback ищет активный флоу по state из URL.
  private stateToUser = new Map<string, number>();

  constructor(
    private usersDb: UsersDb,
    private http: HttpClient = new HttpClient(),
  ) {}

  /** Публичный (для main.ts) — существует ли активный флоу с этим state. */
  lookupPendingByState(state: string): number | null {
    return this.stateToUser.get(state) ?? null;
  }

  /** Публичный (для main.ts) — довести OAuth-редирект до завершения. */
  async completeAuthByCode(state: string, code: string): Promise<{ userId: number; ok: boolean }> {
    const userId = this.stateToUser.get(state);
    if (userId === undefined) return { userId: 0, ok: false };
    const entry = this.active.get(userId);
    if (!entry || entry.cancelled) return { userId, ok: false };
    const ok = await this.exchangeAndFinish(entry, code);
    return { userId, ok };
  }

  async startDeviceAuth(userId: number, onSuccess: OnSuccess, onFailure: OnFailure): Promise<DeviceAuthState | null> {
    const existing = this.active.get(userId);
    if (existing) this.cancelAuthInternal(existing);

    const s = getSettings();
    if (!s.SPOTIFY_CLIENT_ID) {
      log.error("SPOTIFY_CLIENT_ID не задан в .env — авторизация невозможна");
      return null;
    }

    const { verifier, challenge } = makePkcePair();
    const state = base64url(randomBytes(16));
    const usesCallback = Boolean(s.WEBHOOK_HOST);
    const redirectUri = this.redirectUri();

    const url = new URL(`${SPOTIFY_AUTH}/authorize`);
    url.searchParams.set("client_id", s.SPOTIFY_CLIENT_ID);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("redirect_uri", redirectUri);
    url.searchParams.set("code_challenge_method", "S256");
    url.searchParams.set("code_challenge", challenge);
    url.searchParams.set("state", state);
    url.searchParams.set("scope", SPOTIFY_SCOPES);

    let resolveDone!: () => void;
    const done = new Promise<void>((r) => {
      resolveDone = r;
    });
    const entry: ActiveAuth = {
      cancelled: false,
      pkceVerifier: verifier,
      resolveDone,
      onSuccess,
      onFailure,
      deadline: Date.now() + AUTH_TIMEOUT_SEC * 1000,
      state: {
        userId,
        verificationUrl: url.toString(),
        state,
        userCode: usesCallback ? "" : "пришли мне значение параметра `code` из адресной строки после авторизации",
        expiresIn: AUTH_TIMEOUT_SEC,
        usesCallback,
        done,
      },
    };
    this.active.set(userId, entry);
    this.stateToUser.set(state, userId);
    this.armTimeout(entry);
    log.info(`Spotify OAuth стартовал для ${userId} (callback=${usesCallback})`);
    return entry.state;
  }

  cancelAuth(userId: number): boolean {
    const entry = this.active.get(userId);
    if (entry && !entry.cancelled) {
      this.cancelAuthInternal(entry);
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

  /** В paste-режиме юзер шлёт присланный `code=` — завершает авторизацию. */
  async submitPastedCode(userId: number, rawCode: string): Promise<boolean> {
    const entry = this.active.get(userId);
    if (!entry || entry.cancelled) return false;
    const code = extractCode(rawCode);
    if (!code) {
      await entry.onFailure(userId, "не нашёл параметр code — пришли ссылку целиком или значение code=... из адресной строки");
      return false;
    }
    return this.exchangeAndFinish(entry, code);
  }

  private async exchangeAndFinish(entry: ActiveAuth, code: string): Promise<boolean> {
    const s = getSettings();
    try {
      const body = new URLSearchParams();
      body.set("grant_type", "authorization_code");
      body.set("code", code);
      body.set("redirect_uri", this.redirectUri());
      body.set("client_id", s.SPOTIFY_CLIENT_ID);
      body.set("code_verifier", entry.pkceVerifier);
      const res = await this.http.request(`${SPOTIFY_AUTH}/api/token`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: body.toString(),
      });
      if (res.status !== 200) {
        const text = await res.body.text();
        log.warning(`Spotify token exchange HTTP ${res.status}: ${text.slice(0, 200)}`);
        await entry.onFailure(entry.state.userId, "Spotify не отдал токен — код мог протухнуть, попробуй ещё раз");
        return false;
      }
      const token = (await res.body.json()) as SpotifyTokenResponse;
      if (!token.access_token) {
        await entry.onFailure(entry.state.userId, "Spotify вернул пустой токен");
        return false;
      }
      await this.usersDb.save(
        entry.state.userId,
        token.access_token,
        token.refresh_token ?? null,
        token.expires_in ?? null,
      );
      log.info(`авторизация ок для ${entry.state.userId}`);
      await entry.onSuccess(entry.state.userId);
      this.finalize(entry);
      return true;
    } catch (e) {
      log.error(`token exchange упал для ${entry.state.userId}: ${e}`);
      await entry.onFailure(entry.state.userId, "внутренняя ошибка при обмене кода на токен");
      return false;
    }
  }

  async refreshToken(userId: number, refreshToken: string): Promise<string | null> {
    const s = getSettings();
    try {
      const body = new URLSearchParams();
      body.set("grant_type", "refresh_token");
      body.set("refresh_token", refreshToken);
      body.set("client_id", s.SPOTIFY_CLIENT_ID);
      const res = await this.http.request(`${SPOTIFY_AUTH}/api/token`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: body.toString(),
      });
      if (res.status !== 200) {
        const text = await res.body.text();
        log.warning(`refresh для ${userId} HTTP ${res.status}: ${text.slice(0, 200)}`);
        return null;
      }
      const token = (await res.body.json()) as SpotifyTokenResponse;
      if (!token.access_token) return null;
      await this.usersDb.save(userId, token.access_token, token.refresh_token ?? refreshToken, token.expires_in ?? null);
      log.info(`access обновлён для ${userId}`);
      return token.access_token;
    } catch (e) {
      log.warning(`refresh для ${userId} не сработал: ${e}`);
      return null;
    }
  }

  private redirectUri(): string {
    const s = getSettings();
    if (s.WEBHOOK_HOST) return `${s.WEBHOOK_HOST.replace(/\/+$/, "")}/spotify/callback`;
    return "http://127.0.0.1:8888/callback";
  }

  private cancelAuthInternal(entry: ActiveAuth): void {
    entry.cancelled = true;
    this.stateToUser.delete(entry.state.state);
    this.active.delete(entry.state.userId);
    entry.resolveDone();
  }

  private finalize(entry: ActiveAuth): void {
    this.stateToUser.delete(entry.state.state);
    if (this.active.get(entry.state.userId) === entry) this.active.delete(entry.state.userId);
    entry.resolveDone();
  }

  private armTimeout(entry: ActiveAuth): void {
    const ms = Math.max(0, entry.deadline - Date.now());
    setTimeout(() => {
      if (entry.cancelled || this.active.get(entry.state.userId) !== entry) return;
      log.info(`таймаут авторизации ${entry.state.userId}`);
      void Promise.resolve(entry.onFailure(entry.state.userId, "timeout")).catch(() => {});
      this.finalize(entry);
    }, ms).unref?.();
  }
}

/** Достаёт code= из полной ссылки, из query, или считает всё за код. */
export function extractCode(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  try {
    const url = new URL(trimmed.startsWith("http") ? trimmed : `http://x/?${trimmed.replace(/^\?/, "")}`);
    const code = url.searchParams.get("code");
    if (code) return code;
  } catch {
    // не URL — считаем строку кодом
  }
  if (/^[A-Za-z0-9_-]{10,}$/.test(trimmed)) return trimmed;
  return null;
}
