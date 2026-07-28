/** мелкие хелперы для GramIO-контекстов (доступ к сырым полям update). */

/** сырая строка callback_data — работает и для string-, и для RegExp-матчеров
 * (при RegExp GramIO заменяет ctx.data на ctx.queryData, поэтому читаем update). */
export function cbData(ctx: unknown): string {
  const c = ctx as {
    data?: string;
    update?: { callback_query?: { data?: string } };
  };
  if (typeof c.data === "string") return c.data;
  return c.update?.callback_query?.data ?? "";
}
