/** Общие типы бот-слоя. */

/** отправитель апдейта — ровно те поля, что нужны подписи/карточке. */
export interface TgUser {
  id: number;
  username?: string | null;
  firstName?: string | null;
}
