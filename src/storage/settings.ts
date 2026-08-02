/** user-specific настройки бота — в users-БД отдельной таблицей. */
import { usersPool } from "./pool.ts";

export const TRACK_LAYOUTS = new Set(["button", "text", "both", "none"]);
export const DEFAULT_TRACK_LAYOUT = "button";

const TRACK_SEND_MODES = new Set(["stub", "text_media"]);
const DEFAULT_TRACK_SEND_MODE = "text_media";

// качество звука: best — макс. битрейт, economy — ≤192 (меньше вес, влезает в 50МБ).
export const TRACK_QUALITIES = new Set(["best", "economy", "lossless"]);
const DEFAULT_TRACK_QUALITY = "best";

const CARD_LAYOUTS = new Set(["button", "text", "both", "none"]);
const DEFAULT_CARD_LAYOUT = "button";

// стиль карточки: только ambient (mywave убран). Поле живёт в БД для совместимости.
const CARD_STYLES = new Set(["ambient"]);
const DEFAULT_CARD_STYLE = "ambient";

const CARD_PROGRESS_STYLES = new Set(["wavy", "bar"]);
const DEFAULT_CARD_PROGRESS = "wavy";

export const CARD_ASPECTS = new Set(["16:9", "9:16"]);
const DEFAULT_CARD_ASPECT = "16:9";

// порядок важен — в UI рендерится таким же
export const CARD_TOGGLES = ["album", "type", "year", "label", "track_no", "avatar"] as const;
export type CardToggleName = (typeof CARD_TOGGLES)[number];

export const CARD_DEFAULT_TOGGLE: Record<CardToggleName, boolean> = {
  album: true,
  type: false,
  year: true,
  label: false,
  track_no: false,
  avatar: true,
};

export interface UserSettings {
  track_layout: string;
  track_send_mode: string;
  track_quality: string;
  card_style: string;
  card_layout: string;
  card_progress: string;
  card_toggles: Record<CardToggleName, boolean>;
  card_aspect: string;
}

export function norm(v: string | null | undefined, valid: Set<string>, def: string): string {
  return v !== null && v !== undefined && valid.has(v) ? v : def;
}

function toggleColumns(): string[] {
  return CARD_TOGGLES.map((n) => `card_show_${n}`);
}

export class SettingsDb {
  async initSchema(): Promise<void> {
    await usersPool.query(`
      CREATE TABLE IF NOT EXISTS user_settings (
        user_id           BIGINT       PRIMARY KEY,
        track_layout      TEXT         NOT NULL DEFAULT 'button',
        track_send_mode   TEXT         NOT NULL DEFAULT 'text_media',
        track_quality     TEXT         NOT NULL DEFAULT 'best',
        card_style        TEXT         NOT NULL DEFAULT 'ambient',
        card_layout       TEXT         NOT NULL DEFAULT 'button',
        card_progress     TEXT         NOT NULL DEFAULT 'wavy',
        card_show_album    BOOLEAN  NOT NULL DEFAULT TRUE,
        card_show_type     BOOLEAN  NOT NULL DEFAULT FALSE,
        card_show_year     BOOLEAN  NOT NULL DEFAULT TRUE,
        card_show_label    BOOLEAN  NOT NULL DEFAULT FALSE,
        card_show_track_no BOOLEAN  NOT NULL DEFAULT FALSE,
        card_show_avatar   BOOLEAN  NOT NULL DEFAULT TRUE,
        created_at        TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
        updated_at        TIMESTAMPTZ  NOT NULL DEFAULT NOW()
      ) WITH (fillfactor = 80)
    `);
    // миграции для уже существующих таблиц
    await usersPool.query(
      "ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS card_progress TEXT NOT NULL DEFAULT 'wavy'",
    );
    await usersPool.query(
      "ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS card_layout TEXT NOT NULL DEFAULT 'button'",
    );
    await usersPool.query(
      "ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS track_send_mode TEXT NOT NULL DEFAULT 'text_media'",
    );
    // ADD COLUMN IF NOT EXISTS не меняет дефолт существующей колонки — выставляем явно
    await usersPool.query("ALTER TABLE user_settings ALTER COLUMN track_send_mode SET DEFAULT 'text_media'");
    await usersPool.query(
      "ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS track_quality TEXT NOT NULL DEFAULT 'best'",
    );
    for (const name of CARD_TOGGLES) {
      const def = CARD_DEFAULT_TOGGLE[name] ? "TRUE" : "FALSE";
      await usersPool.query(
        `ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS card_show_${name} BOOLEAN NOT NULL DEFAULT ${def}`,
      );
    }
    await usersPool.query(
      "ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS card_aspect TEXT NOT NULL DEFAULT '16:9'",
    );
  }

  async get(userId: number): Promise<UserSettings> {
    const cols =
      "track_layout, track_send_mode, track_quality, card_style, card_layout, card_progress, card_aspect, " +
      toggleColumns().join(", ");
    const res = await usersPool.query<Record<string, unknown>>(`SELECT ${cols} FROM user_settings WHERE user_id = $1`, [
      userId,
    ]);
    const row = res.rows[0];
    if (row === undefined) {
      return {
        track_layout: DEFAULT_TRACK_LAYOUT,
        track_send_mode: DEFAULT_TRACK_SEND_MODE,
        track_quality: DEFAULT_TRACK_QUALITY,
        card_style: DEFAULT_CARD_STYLE,
        card_layout: DEFAULT_CARD_LAYOUT,
        card_progress: DEFAULT_CARD_PROGRESS,
        card_toggles: { ...CARD_DEFAULT_TOGGLE },
        card_aspect: DEFAULT_CARD_ASPECT,
      };
    }
    const toggles = {} as Record<CardToggleName, boolean>;
    for (const name of CARD_TOGGLES) toggles[name] = Boolean(row[`card_show_${name}`]);
    return {
      track_layout: norm(row.track_layout as string, TRACK_LAYOUTS, DEFAULT_TRACK_LAYOUT),
      track_send_mode: norm(row.track_send_mode as string, TRACK_SEND_MODES, DEFAULT_TRACK_SEND_MODE),
      track_quality: norm(row.track_quality as string, TRACK_QUALITIES, DEFAULT_TRACK_QUALITY),
      card_style: norm(row.card_style as string, CARD_STYLES, DEFAULT_CARD_STYLE),
      card_layout: norm(row.card_layout as string, CARD_LAYOUTS, DEFAULT_CARD_LAYOUT),
      card_progress: norm(row.card_progress as string, CARD_PROGRESS_STYLES, DEFAULT_CARD_PROGRESS),
      card_toggles: toggles,
      card_aspect: norm(row.card_aspect as string, CARD_ASPECTS, DEFAULT_CARD_ASPECT),
    };
  }

  private async setColumn(userId: number, column: string, value: string | boolean): Promise<void> {
    await usersPool.query(
      `
      INSERT INTO user_settings (user_id, ${column}, updated_at)
      VALUES ($1, $2, NOW())
      ON CONFLICT (user_id) DO UPDATE SET
          ${column}  = EXCLUDED.${column},
          updated_at = NOW()
      `,
      [userId, value],
    );
  }

  /** Общий паттерн для «выбери один из» настроек; setCardToggle — отдельно, там булев флаг. */
  private async setNormalized(
    userId: number,
    column: string,
    value: string,
    valid: Set<string>,
    def: string,
  ): Promise<string> {
    const v = norm(value, valid, def);
    await this.setColumn(userId, column, v);
    return v;
  }

  setTrackLayout(userId: number, layout: string): Promise<string> {
    return this.setNormalized(userId, "track_layout", layout, TRACK_LAYOUTS, DEFAULT_TRACK_LAYOUT);
  }

  setTrackSendMode(userId: number, mode: string): Promise<string> {
    return this.setNormalized(userId, "track_send_mode", mode, TRACK_SEND_MODES, DEFAULT_TRACK_SEND_MODE);
  }

  setTrackQuality(userId: number, quality: string): Promise<string> {
    return this.setNormalized(userId, "track_quality", quality, TRACK_QUALITIES, DEFAULT_TRACK_QUALITY);
  }

  setCardStyle(userId: number, style: string): Promise<string> {
    return this.setNormalized(userId, "card_style", style, CARD_STYLES, DEFAULT_CARD_STYLE);
  }

  setCardLayout(userId: number, layout: string): Promise<string> {
    return this.setNormalized(userId, "card_layout", layout, CARD_LAYOUTS, DEFAULT_CARD_LAYOUT);
  }

  setCardProgress(userId: number, style: string): Promise<string> {
    return this.setNormalized(userId, "card_progress", style, CARD_PROGRESS_STYLES, DEFAULT_CARD_PROGRESS);
  }

  setCardAspect(userId: number, aspect: string): Promise<string> {
    return this.setNormalized(userId, "card_aspect", aspect, CARD_ASPECTS, DEFAULT_CARD_ASPECT);
  }

  async setCardToggle(userId: number, name: string, value: boolean): Promise<boolean> {
    if (!(CARD_TOGGLES as readonly string[]).includes(name)) {
      throw new Error(`неизвестный card-toggle: ${JSON.stringify(name)}`);
    }
    // имя колонки безопасно — прошло whitelist по CARD_TOGGLES
    await this.setColumn(userId, `card_show_${name}`, Boolean(value));
    return Boolean(value);
  }
}
