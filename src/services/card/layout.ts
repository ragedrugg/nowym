import type { CardMeta } from "../../yandex/types.ts";

// базовые размеры 16:9 (дефолт) — остальные вычисляются в getLayoutSpec()
const W_DEFAULT = 1600;
const H_DEFAULT = 900;

export const L = {
  margin: 56,
  coverSize: 540,
  coverRadius: 44,
  textPadLeft: 64,
  textPadRight: 56,
  artistSize: 38,
  titleSize: 84,
  titleSizeMin: 56,
  metaSize: 30,
  metaPadTop: 14,
  waveHeight: 140,
  waveStroke: 10,
  waveAmplitude: 14,
  waveWavelength: 50,
  inactiveStroke: 6,
  stopRadius: 10,
  timeSize: 30,
  timePadTop: 26,
  badgeSize: 120,
  attrHeight: 76,
  attrAvatarSize: 60,
  attrHandleSize: 36,
  attrLabelSize: 22,
} as const;

// ── раскладки карточки ────────────────────────────────────────────────────────

// поддерживаются только "16:9" (side) и "9:16" (stack) — см. CARD_ASPECTS в
// storage/settings.ts, единственный источник валидации аспекта в системе.
type LayoutMode = "side" | "stack";

export interface LayoutSpec {
  mode: LayoutMode;
  W: number;
  H: number;
  coverX: number;
  coverY: number;
  coverSize: number;
  coverRadius: number;
  badgeX: number;
  badgeY: number;
  badgeSize: number;
  attrY: number;
  attrLeft: number;
  attrRight: number;
  textX: number;
  textMaxW: number;
  artistMaxW: number;
  mainTextY: number; // Y художника (тайтл идёт под ним, см. drawArtistAndTitle)
  artistSize: number;
  titleMaxSize: number;
  titleMinSize: number;
  metaSize: number;
  timeSize: number;
  bgGradDir: "right" | "left" | "bottom";
  waveFixedY?: number; // только "side": волна привязана к низу обложки
  lyricsScale?: number; // масштаб шрифтов лирики (default 1.0)
  lyricsTopGap?: number; // отступ от тайтла до области лирики (default 40)
}

export function getLayoutSpec(aspect: string): LayoutSpec {
  const m = 56; // margin
  const attrH = L.attrHeight; // 76
  const attrZoneH = attrH + 16; // 92
  const cr = L.coverRadius; // 44

  if (aspect === "9:16") {
    const W = 900,
      H = 1600;
    const attrY = H - m - attrH; // 1468
    const tw = W - 2 * m; // 788
    const bsz = 96,
      bx = W - m - bsz; // 748
    const csz = tw; // 788 — полная ширина за вычетом отступов
    return {
      mode: "stack",
      W,
      H,
      coverX: m,
      coverY: m,
      coverSize: csz,
      coverRadius: cr,
      badgeX: bx,
      badgeY: m,
      badgeSize: 0,
      attrY,
      attrLeft: m,
      attrRight: W - m,
      textX: m,
      textMaxW: tw,
      artistMaxW: tw,
      mainTextY: m + csz + 32, // 876
      artistSize: 42,
      titleMaxSize: 84,
      titleMinSize: 56,
      metaSize: 32,
      timeSize: 32,
      bgGradDir: "bottom",
      lyricsScale: 0.85,
      lyricsTopGap: 20,
    };
  }

  // дефолт: 16:9
  const W = W_DEFAULT,
    H = H_DEFAULT;
  const coverSize = L.coverSize; // 540
  const contentBottom = H - attrZoneH; // 808
  const coverY = Math.round(m + (contentBottom - m - coverSize) / 2); // 162
  const attrY = H - m - attrH; // 768
  const bsz = L.badgeSize; // 120
  const cx = m;
  const tx = cx + coverSize + L.textPadLeft; // 660
  const tw = W - m - L.textPadRight - tx; // 828
  const bx = W - m - bsz; // 1424
  return {
    mode: "side",
    W,
    H,
    coverX: cx,
    coverY,
    coverSize,
    coverRadius: cr,
    badgeX: bx,
    badgeY: m,
    badgeSize: bsz,
    attrY,
    attrLeft: m,
    attrRight: W - m,
    textX: tx,
    textMaxW: tw,
    artistMaxW: bx - tx - 24, // 740
    mainTextY: coverY + 12,
    artistSize: L.artistSize,
    titleMaxSize: L.titleSize,
    titleMinSize: L.titleSizeMin,
    metaSize: L.metaSize,
    timeSize: L.timeSize,
    bgGradDir: "right",
    waveFixedY: coverY + coverSize - (L.waveHeight / 2 + 56), // 576
  };
}

export interface CardToggles {
  album?: boolean;
  type?: boolean;
  year?: boolean;
  label?: boolean;
  track_no?: boolean;
  avatar?: boolean;
}

export interface CardOptions {
  style?: string;
  progress?: string; // 'wavy' | 'bar'
  toggles?: CardToggles;
  aspect?: string; // '16:9' | '9:16'
}

/** Блок лирики на карточке: все строки песни + индекс активной (подсвечиваемой).
 * Когда задан — вместо meta/прогресса/таймкодов рисуется лента строк вокруг
 * активной. activeIndex<0 → центрируем по началу песни.
 * activeFloat — дробный индекс для плавной анимации в видеокарточке:
 *   2.0 = строка 2 полностью активна, 2.6 = 60% перехода 2→3. */
export interface LyricsBlock {
  lines: string[];
  activeIndex: number;
  activeFloat?: number;
  countdownText?: string; // "3" | "2" | "1"
  countdownAlpha?: number; // 0..1
}

export interface RenderCardArgs {
  coverBytes: Buffer | null;
  title: string;
  artist: string;
  progressMs: number;
  durationMs: number;
  paused?: boolean;
  senderHandle?: string | null;
  senderAvatar?: Buffer | null;
  botUsername?: string | null;
  meta?: Partial<CardMeta>;
  cardOptions?: CardOptions;
  lyrics?: LyricsBlock | null;
  /** при true возвращает сырой RGBA-буфер пикселей вместо JPEG — избегает
   * кодирования/декодирования JPEG на каждый кадр при пайпе в ffmpeg. */
  rawRGBA?: boolean;
  /** без линии прогресса и таймингов (карточка по ссылке на трек, без контекста воспроизведения). */
  hideProgress?: boolean;
}
