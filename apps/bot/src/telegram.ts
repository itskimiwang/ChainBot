import { createLogger, type AppConfig, type MessageBus } from '@rhc/core';

const log = createLogger('telegram');

export interface TelegramCommands {
  pause(): void;
  resume(): void;
  kill(): Promise<void>;
  status(): string;
  positions(): string;
}

/**
 * Telegram alerts and remote control.
 *
 * Uses the Bot API over plain HTTPS rather than a client library — it is four endpoints,
 * and every dependency in a process holding a funded key is a liability worth avoiding.
 *
 * Disabled cleanly when no token is configured: the bot must run and trade on paper with
 * no credentials at all, so a missing token is a normal state and not a failure.
 */
export class TelegramNotifier {
  private readonly token: string | undefined;
  private readonly chatId: string | undefined;
  private offset = 0;
  private timer: NodeJS.Timeout | null = null;
  private commands: TelegramCommands | null = null;

  readonly enabled: boolean;

  constructor(
    private readonly config: AppConfig,
    private readonly bus: MessageBus,
  ) {
    this.token = config.secrets.telegramBotToken;
    this.chatId = config.secrets.telegramChatId;
    this.enabled = config.bot.alerts.telegram.enabled && Boolean(this.token && this.chatId);
  }

  start(commands: TelegramCommands): void {
    this.commands = commands;

    this.bus.subscribe('alert.notify', (alert) => {
      const icon = alert.level === 'error' ? '\u{1F6D1}' : alert.level === 'warn' ? '\u{26A0}\u{FE0F}' : '\u{2705}';
      void this.send(`${icon} <b>${escapeHtml(alert.title)}</b>\n${escapeHtml(alert.body)}`);
    });

    if (!this.enabled) {
      log.info('telegram alerts disabled (no bot token configured); trade notifications go to the log only');
      return;
    }

    if (this.config.bot.alerts.telegram.commandPolling) {
      this.timer = setInterval(() => void this.poll(), this.config.bot.alerts.telegram.pollIntervalMs);
    }

    void this.send(
      `\u{1F4E1} <b>Bot online</b>\nMode: <code>${this.config.bot.mode}</code>\n` +
        'Commands: /status /positions /pause /resume /kill',
    );
    log.info('telegram notifier started');
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async send(html: string): Promise<void> {
    if (!this.enabled) return;
    try {
      await fetch(`https://api.telegram.org/bot${this.token}/sendMessage`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          chat_id: this.chatId,
          text: html,
          parse_mode: 'HTML',
          disable_web_page_preview: true,
        }),
        signal: AbortSignal.timeout(6_000),
      });
    } catch (err) {
      // Alerting is best-effort. A Telegram outage must never stall the trading loop.
      log.debug('telegram send failed', { err: (err as Error).message });
    }
  }

  private async poll(): Promise<void> {
    if (!this.commands) return;

    try {
      const response = await fetch(
        `https://api.telegram.org/bot${this.token}/getUpdates?offset=${this.offset}&timeout=0`,
        { signal: AbortSignal.timeout(8_000) },
      );
      if (!response.ok) return;

      const body = (await response.json()) as {
        result?: Array<{ update_id: number; message?: { text?: string; chat?: { id: number } } }>;
      };

      for (const update of body.result ?? []) {
        this.offset = update.update_id + 1;
        const text = update.message?.text?.trim();
        // Only obey the configured chat. Anyone can find a bot and message it.
        if (!text || String(update.message?.chat?.id) !== this.chatId) continue;
        await this.handleCommand(text);
      }
    } catch {
      // Transient; the next tick retries.
    }
  }

  private async handleCommand(text: string): Promise<void> {
    if (!this.commands) return;
    const command = text.split(/\s+/)[0]?.toLowerCase().replace(/@.*$/, '');

    switch (command) {
      case '/status':
        await this.send(this.commands.status());
        break;
      case '/positions':
        await this.send(this.commands.positions());
        break;
      case '/pause':
        this.commands.pause();
        break;
      case '/resume':
        this.commands.resume();
        break;
      case '/kill':
        await this.send('\u{1F6D1} <b>Kill switch engaged</b>\nFlattening all positions and halting entries.');
        await this.commands.kill();
        break;
      default:
        await this.send('Unknown command. Try /status /positions /pause /resume /kill');
    }
  }
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
