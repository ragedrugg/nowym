/** Троттленные алерты админу: первое сообщение уходит сразу, далее не чаще
 * раза в cooldown — с агрегированным счётчиком накопленных за окно ошибок. */
import { getLogger } from "./logging.ts";

const log = getLogger("infra.admin_alerter");

export class AdminAlerter {
  private lastSentAt = 0;
  private pending = 0;
  private lastMsg = "";
  private flushing = false;
  private scheduled = false;
  private muted = false;

  private readonly send: (text: string) => Promise<void>;
  private readonly cooldownMs: number;

  constructor(send: (text: string) => Promise<void>, cooldownMs: number = 5 * 60 * 1000) {
    this.send = send;
    this.cooldownMs = cooldownMs;
  }

  /** глушит дальнейшие алерты (shutdown: хендлеры, недоработавшие к закрытию Redis/pg,
   * падают «Connection is closed» — это не ошибка, а деплой). Накопленное тоже не уйдёт. */
  mute(): void {
    this.muted = true;
    this.pending = 0;
  }

  report(msg: string): void {
    if (this.muted) {
      log.debug(`[admin_alerter] shutdown, алерт не отправлен: ${msg}`);
      return;
    }
    this.pending += 1;
    this.lastMsg = msg;
    void this.maybeFlush();
  }

  private async maybeFlush(): Promise<void> {
    if (this.flushing || this.muted) return;
    const now = Date.now();
    const remaining = this.cooldownMs - (now - this.lastSentAt);
    if (remaining > 0) {
      // если вспышка ошибок закончится ДО истечения cooldown, report() больше
      // не вызовется — без таймера накопленный pending так и остался бы
      // неотправленным до следующей случайной, никак не связанной ошибки.
      if (!this.scheduled) {
        this.scheduled = true;
        setTimeout(() => {
          this.scheduled = false;
          void this.maybeFlush();
        }, remaining).unref?.();
      }
      return;
    }
    this.flushing = true;
    this.lastSentAt = now;
    const n = this.pending;
    this.pending = 0;
    const text = n > 1 ? `⚠️ ${n} ошибок за последнее окно, последняя:\n${this.lastMsg}` : `⚠️ ошибка:\n${this.lastMsg}`;
    try {
      await this.send(text);
    } catch (e) {
      log.warning(`[admin_alerter] не отправил алерт: ${e}`);
    } finally {
      this.flushing = false;
    }
  }
}
