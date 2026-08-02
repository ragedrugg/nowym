/** DI-контейнер: держит все сервисы и кэши, резолвит per-user YandexClient/
 * SearchService, проактивно обновляет токен. Создаётся в main, стартует с
 * готовым GramIO-ботом. */

import type { DialogManager } from "@gramio/dialogs";
import type { Bot } from "gramio";
import { GeniusClient } from "../genius/client.ts";
import { sleep } from "../infra/async.ts";
import { crypto } from "../infra/crypto.ts";
import { HttpClient } from "../infra/http.ts";
import { getLogger } from "../infra/logging.ts";
import { TTLCache } from "../infra/memoryCache.ts";
import { DownloadConcurrency } from "../infra/queue.ts";
import { UserRateLimiter } from "../infra/rateLimit.ts";
import { AlbumService } from "../services/albums.ts";
import { AuthService } from "../services/auth.ts";
import { BroadcastService } from "../services/broadcast.ts";
import { CacheService } from "../services/cache.ts";
import { CardRenderPool } from "../services/cardRenderPool.ts";
import type { NowPlayingWatcher } from "../services/nowPlayingWatcher.ts";
import { type InlineResult, SearchService } from "../services/search.ts";
import { getSettings } from "../settings.ts";
import { CacheDb } from "../storage/cache.ts";
import { KnownChatsDb } from "../storage/knownChats.ts";
import { closeAll as closeDbPools, initializeAll } from "../storage/pool.ts";
import { SettingsDb, type UserSettings } from "../storage/settings.ts";
import { UsersDb } from "../storage/users.ts";
import { TaggingService } from "../tagging/service.ts";
import { type YandexClient, YandexClientFactory } from "../yandex/client.ts";
import { ChannelSender } from "./telegramSender.ts";

const log = getLogger("bot.container");

export class Container {
  httpClient!: HttpClient;
  downloadQueue!: DownloadConcurrency;
  inlineLimiter!: UserRateLimiter;
  downloadLimiter!: UserRateLimiter;
  trackCache!: TTLCache<InlineResult[]>;
  avatarCache!: TTLCache<Buffer>;
  // inline_message_id → user_id владельца. Telegram в callback от инлайн-сообщений
  // не отдаёт автора, поэтому запоминаем на chosen_result и проверяем на тапе load.
  inlineOwners!: TTLCache<number>;
  usersDb!: UsersDb;
  cacheDb!: CacheDb;
  settingsDb!: SettingsDb;
  knownChatsDb!: KnownChatsDb;
  userSettingsCache!: TTLCache<UserSettings>;
  npWatcher: NowPlayingWatcher | null = null;
  authService!: AuthService;
  metadataService!: TaggingService;
  cacheService!: CacheService;
  albumService!: AlbumService;
  broadcastService!: BroadcastService;
  cardRenderPool!: CardRenderPool;
  genius: GeniusClient | null = null;
  botUsername: string | null = null;
  channelId!: string;
  // фабрика background-менеджера диалога — рендерит/редактит сообщение диалога
  // извне хендлера (нужно для device-flow login, где ответ приходит асинхронно).
  dialogBackground: ((bot: Bot, stackKey: string) => Promise<DialogManager>) | null = null;

  private bot!: Bot;
  // TTL, не голый Map: без него оба кэша росли бы весь lifetime процесса —
  // на 5000+ лайфтайм-юзерах это гигабайты закэшированных YaTrack/http-клиентов.
  // Клиенты дешёвые в пересборке, час простоя не жалко.
  private yandexClients!: TTLCache<YandexClient>;
  private searchServices!: TTLCache<SearchService>;
  // дедуп конкурентных refreshToken на одного юзера — иначе resolveToken()
  // (проактивный путь) и makeRefreshCallback (реактивный, на 401 внутри
  // YandexClient) могли одновременно слать один и тот же refresh_token,
  // и параллельные usersDb.save() гонялись бы за тем, чья пара токенов останется.
  private refreshInFlight = new Map<number, Promise<string | null>>();

  async start(bot: Bot): Promise<void> {
    log.info("инициализация контейнера...");
    this.bot = bot;
    const s = getSettings();

    crypto.init(s.TOKEN_ENCRYPTION_KEY);

    // ретраим get_me на случай моргающего DNS/сети апстрима
    let delay = 2000;
    let me: Awaited<ReturnType<Bot["api"]["getMe"]>> | null = null;
    for (let attempt = 1; attempt <= 6; attempt++) {
      try {
        me = await bot.api.getMe();
        break;
      } catch (e) {
        if (attempt === 6) throw e;
        log.warning(`[startup] get_me попытка ${attempt} упала (${e}), retry через ${delay / 1000}s`);
        await sleep(delay);
        delay = Math.min(delay * 2, 30000);
      }
    }
    this.botUsername = me?.username ?? null;

    this.httpClient = new HttpClient();
    this.downloadQueue = new DownloadConcurrency(s.DOWNLOAD_QUEUE_CONCURRENCY);

    this.inlineLimiter = new UserRateLimiter(s.RATE_INLINE_MAX_TOKENS, s.RATE_INLINE_RATE_PER_SEC);
    this.inlineLimiter.start();
    this.downloadLimiter = new UserRateLimiter(s.RATE_DOWNLOAD_MAX_TOKENS, s.RATE_DOWNLOAD_RATE_PER_SEC);
    this.downloadLimiter.start();

    this.trackCache = new TTLCache<InlineResult[]>(s.MEMORY_CACHE_SIZE, s.MEMORY_CACHE_TTL, s.CACHE_CLEANUP_INTERVAL);
    // аватарки: позитив 6ч, негатив 30мин
    this.avatarCache = new TTLCache<Buffer>(500, 6 * 3600, 600);
    // владельцы инлайнов: живут сутки (инлайн-сообщение могут переоткрыть позже)
    this.inlineOwners = new TTLCache<number>(10000, 24 * 3600, 3600);
    // per-user YandexClient/SearchService — час простоя, пересборка дешёвая
    this.yandexClients = new TTLCache<YandexClient>(1000, 3600, 600);
    this.searchServices = new TTLCache<SearchService>(1000, 3600, 600);

    await initializeAll();
    this.usersDb = new UsersDb();
    this.cacheDb = new CacheDb();
    this.settingsDb = new SettingsDb();
    this.knownChatsDb = new KnownChatsDb();
    await this.usersDb.initSchema();
    await this.cacheDb.initSchema();
    await this.settingsDb.initSchema();
    await this.knownChatsDb.initSchema();
    // идемпотентно: подхватывает уже залогиненных юзеров как «известные чаты»,
    // чтобы рассылка сразу видела их, а не только тех, кто напишет боту заново.
    await this.knownChatsDb.backfillFromUserCredentials();

    this.userSettingsCache = new TTLCache<UserSettings>(2000, 300, 300);

    this.authService = new AuthService(this.usersDb);
    this.metadataService = new TaggingService();
    this.cardRenderPool = new CardRenderPool();
    this.cardRenderPool.start();

    this.channelId = s.TELEGRAM_CHANNEL_ID;
    const sender = new ChannelSender(bot, s.TELEGRAM_CHANNEL_ID);
    this.cacheService = new CacheService(sender, this.cacheDb, this.httpClient, this.metadataService);

    if (s.GENIUS_TOKEN) this.genius = new GeniusClient(s.GENIUS_TOKEN);

    this.albumService = new AlbumService(
      this.cacheDb,
      this.cacheService,
      this.downloadQueue,
      this.httpClient,
      bot,
      (userId) => this.getUserSettings(userId),
    );
    this.broadcastService = new BroadcastService(this.knownChatsDb, bot);

    log.info("контейнер готов");
  }

  async stop(): Promise<void> {
    log.info("остановка контейнера...");
    this.inlineLimiter?.shutdown();
    this.downloadLimiter?.shutdown();
    await this.cardRenderPool?.stop();
    await this.trackCache?.close();
    await this.avatarCache?.close();
    await this.inlineOwners?.close();
    await this.userSettingsCache?.close();
    await this.yandexClients?.close();
    await this.searchServices?.close();
    await this.httpClient?.close();
    await closeDbPools();
    log.info("контейнер остановлен");
  }

  async getYandexService(token: string, userId?: number): Promise<YandexClient> {
    if (userId === undefined) return YandexClientFactory.create(token);

    const key = String(userId);
    const cached = this.yandexClients.get(key);
    if (cached !== null) return cached;

    const cb = this.makeRefreshCallback(userId);
    const client = await YandexClientFactory.create(token, cb);
    this.yandexClients.set(key, client);
    return client;
  }

  async getTrackService(token: string, userId?: number): Promise<SearchService> {
    if (userId === undefined) {
      const yandex = await this.getYandexService(token);
      return new SearchService(yandex, this.trackCache, this.cacheService, this.botUsername, null);
    }
    const key = String(userId);
    const cached = this.searchServices.get(key);
    if (cached !== null) return cached;

    const yandex = await this.getYandexService(token, userId);
    const svc = new SearchService(yandex, this.trackCache, this.cacheService, this.botUsername, userId);
    this.searchServices.set(key, svc);
    return svc;
  }

  private makeRefreshCallback(userId: number): () => Promise<string | null> {
    return async () => {
      const creds = await this.usersDb.get(userId);
      if (!creds || !creds.refresh_token) return null;
      return this.refreshTokenDeduped(userId, creds.refresh_token);
    };
  }

  /** дедуп конкурентных refreshToken(userId, ...) — второй и последующий
   *  вызовы просто ждут уже идущий рефреш вместо своего похода за новым токеном. */
  private refreshTokenDeduped(userId: number, refreshToken: string): Promise<string | null> {
    const existing = this.refreshInFlight.get(userId);
    if (existing !== undefined) return existing;
    const task = this.authService.refreshToken(userId, refreshToken).finally(() => {
      if (this.refreshInFlight.get(userId) === task) this.refreshInFlight.delete(userId);
    });
    this.refreshInFlight.set(userId, task);
    return task;
  }

  /** актуальный access_token, проактивно обновляет если истекает. */
  async resolveToken(userId: number): Promise<string | null> {
    const creds = await this.usersDb.get(userId);
    if (!creds) return null;

    const expiresAt = creds.expires_at;
    const soonExpired = expiresAt != null && Date.now() / 1000 > expiresAt - 300;
    if (soonExpired && creds.refresh_token) {
      const newToken = await this.refreshTokenDeduped(userId, creds.refresh_token);
      if (newToken) {
        // сбрасываем кэш: закэшированный YandexClient держит старый token
        this.invalidateTokenCacheForUser(userId);
        return newToken;
      }
      log.warning(`не вышло обновить токен для ${userId}, юзаю старый`);
    }
    return creds.access_token;
  }

  invalidateTokenCacheForUser(userId: number): void {
    this.yandexClients.delete(String(userId));
    this.searchServices.delete(String(userId));
  }

  async getUserSettings(userId: number): Promise<UserSettings> {
    const key = `settings:${userId}`;
    const cached = this.userSettingsCache?.get(key);
    if (cached != null) return cached;
    const data = await this.settingsDb.get(userId);
    this.userSettingsCache?.set(key, data);
    return data;
  }

  invalidateUserSettings(userId: number): void {
    this.userSettingsCache?.delete(`settings:${userId}`);
  }
}
