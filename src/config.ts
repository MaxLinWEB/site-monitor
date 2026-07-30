/**
 * Configuration: loaded once from environment (.env) and validated up-front so
 * the process fails fast with a clear message instead of misbehaving at runtime.
 */
import path from 'node:path';
import dotenv from 'dotenv';

dotenv.config();

export interface Config {
  siteUrl: string;
  checkIntervalMs: number;
  timeoutMs: number;
  failuresToDown: number;
  successesToUp: number;
  telegramBotToken: string;
  telegramChatId: string;
  telegramApiBase: string;
  /** HTTP status-API port. 0 = disabled. Uses $PORT (e.g. Railway) then $STATUS_PORT. */
  statusPort: number;
  // Optional / advanced (sensible defaults).
  logDir: string;
  logMaxBytes: number;
  logMaxFiles: number;
  heartbeatIntervalMs: number;
  telegramRetries: number;
  userAgent: string;
}

function required(name: string): string {
  const value = process.env[name];
  if (!value || value.trim() === '') {
    throw new Error(`Missing required env var ${name}. Copy .env.example to .env and fill it in.`);
  }
  return value.trim();
}

function positiveNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(`Env var ${name} must be a positive number, got "${raw}".`);
  }
  return n;
}

function integer(name: string, fallback: number): number {
  return Math.floor(positiveNumber(name, fallback));
}

/** Optional TCP port from $PORT (platform-injected) or $STATUS_PORT. 0 = disabled. */
function statusPort(): number {
  const raw = (process.env.PORT ?? process.env.STATUS_PORT ?? '').trim();
  if (raw === '') return 0;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0 || n > 65_535) {
    throw new Error(`PORT/STATUS_PORT must be a valid port (0-65535), got "${raw}".`);
  }
  return n;
}

export function loadConfig(): Config {
  const siteUrl = required('SITE_URL');
  try {
    // Fail fast on a malformed URL rather than deep inside the checker.
    new URL(siteUrl);
  } catch {
    throw new Error(`SITE_URL is not a valid URL: "${siteUrl}"`);
  }

  return {
    siteUrl,
    checkIntervalMs: positiveNumber('CHECK_INTERVAL', 30_000),
    timeoutMs: positiveNumber('TIMEOUT', 10_000),
    failuresToDown: integer('FAILURES_TO_DOWN', 3),
    successesToUp: integer('SUCCESSES_TO_UP', 2),
    telegramBotToken: required('TELEGRAM_BOT_TOKEN'),
    telegramChatId: required('TELEGRAM_CHAT_ID'),
    telegramApiBase: (process.env.TELEGRAM_API_BASE?.trim() || 'https://api.telegram.org').replace(
      /\/+$/,
      '',
    ),
    statusPort: statusPort(),
    logDir: process.env.LOG_DIR?.trim() || path.join(process.cwd(), 'logs'),
    logMaxBytes: integer('LOG_MAX_BYTES', 5 * 1024 * 1024),
    logMaxFiles: integer('LOG_MAX_FILES', 5),
    heartbeatIntervalMs: positiveNumber('HEARTBEAT_INTERVAL', 24 * 60 * 60 * 1000),
    telegramRetries: integer('TELEGRAM_RETRIES', 3),
    userAgent: process.env.USER_AGENT?.trim() || 'site-monitor/1.0',
  };
}
