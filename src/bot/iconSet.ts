/** Резолвер премиум-эмодзи (icon_custom_emoji_id, Bot API 10.0) для иконок кнопок меню.
 *
 * На старте подтягивает набор кастом-эмодзи через getStickerSet и строит карту
 * `стандартный эмодзи → custom_emoji_id`. Кнопки меню (markup.ts) спрашивают
 * iconFor(emoji): есть ID — рисуем премиум-иконку, иначе фолбэк на текстовый глиф.
 *
 * Рендерится у владельца с Premium для сообщений, что бот шлёт в лс/группы. */
import type { Bot } from "gramio";
import { getLogger } from "../infra/logging.ts";

const log = getLogger("iconset");

let ICON_MAP = new Map<string, string>();

/** близкие по смыслу эмодзи, если в наборе нет точного (tgiosicons: 🔓 есть, 🔐 нет). */
const ICON_ALIASES: Readonly<Record<string, readonly string[]>> = {
  "🔐": ["🔓", "🔒"],
};

/** custom_emoji_id для стандартного эмодзи (или его алиаса), если набор его покрывает. */
export function iconFor(emoji: string): string | undefined {
  const id = ICON_MAP.get(emoji);
  if (id !== undefined) return id;
  for (const alias of ICON_ALIASES[emoji] ?? []) {
    const aliasId = ICON_MAP.get(alias);
    if (aliasId !== undefined) return aliasId;
  }
  return undefined;
}

/** Подтягивает набор кастом-эмодзи и заполняет карту emoji→id.
 * Тихо логирует и оставляет карту пустой при сбое (кнопки откатятся на глифы). */
export async function resolveIconSet(bot: Bot, setName: string): Promise<void> {
  try {
    const set = await bot.api.getStickerSet({ name: setName });
    const map = new Map<string, string>();
    for (const st of set.stickers) {
      if (st.custom_emoji_id && st.emoji && !map.has(st.emoji)) {
        map.set(st.emoji, st.custom_emoji_id);
      }
    }
    ICON_MAP = map;
    log.info(`[iconset] набор «${setName}»: ${map.size} иконок`);
  } catch (e) {
    log.warning(`[iconset] не удалось загрузить набор «${setName}» (${e}); кнопки на глифах`);
  }
}
