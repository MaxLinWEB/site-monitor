/**
 * Telegram Bot API transport.
 *
 * Pure delivery layer — message *content* is composed by the caller. Sends are
 * retried with exponential backoff and honour Telegram's own 429 `retry_after`,
 * because a dropped notification is the one failure this daemon must avoid.
 */
import { sleep } from './utils';

export interface TelegramClient {
  send(text: string): Promise<boolean>;
}

export interface TelegramDeps {
  botToken: string;
  chatId: string;
  apiBase: string;
  retries: number;
  log: (level: 'info' | 'warn' | 'error', message: string) => void;
}

const SEND_TIMEOUT_MS = 15_000;

interface TelegramErrorBody {
  parameters?: { retry_after?: number };
}

export function createTelegramClient(deps: TelegramDeps): TelegramClient {
  const endpoint = `${deps.apiBase}/bot${deps.botToken}/sendMessage`;
  const attempts = Math.max(1, deps.retries);

  async function send(text: string): Promise<boolean> {
    const payload = {
      chat_id: deps.chatId,
      text,
      disable_web_page_preview: true,
    };

    for (let attempt = 1; attempt <= attempts; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), SEND_TIMEOUT_MS);
      try {
        const res = await fetch(endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
          signal: controller.signal,
        });

        if (res.ok) return true;

        if (res.status === 429) {
          const body = (await res.json().catch(() => null)) as TelegramErrorBody | null;
          const retryAfter = body?.parameters?.retry_after ?? 2 ** attempt;
          deps.log('warn', `Telegram rate-limited; retrying in ${retryAfter}s`);
          await sleep(retryAfter * 1000);
          continue;
        }

        const errText = await res.text().catch(() => '');
        deps.log('error', `Telegram send failed: HTTP ${res.status} ${errText}`.trim());
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        deps.log('warn', `Telegram send error (attempt ${attempt}/${attempts}): ${reason}`);
      } finally {
        clearTimeout(timer);
      }

      if (attempt < attempts) {
        await sleep(2 ** attempt * 250); // 500ms, 1s, 2s, …
      }
    }

    deps.log('error', `Telegram send gave up after ${attempts} attempts`);
    return false;
  }

  return { send };
}
