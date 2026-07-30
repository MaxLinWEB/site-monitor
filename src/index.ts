/**
 * Monitor entrypoint.
 *
 * Runs a check every `CHECK_INTERVAL` ms, debounces flapping via consecutive
 * failure/success thresholds, and pushes Telegram notifications only when the
 * confirmed status changes. Ships with startup + daily heartbeat messages,
 * running statistics, colored console output, and graceful shutdown.
 */
import { loadConfig, type Config } from './config';
import { check, type CheckResult } from './checker';
import { createLogger, type Logger } from './logger';
import { createTelegramClient, type TelegramClient } from './telegram';
import { startStatusServer, type StatusServer, type StatusSnapshot } from './statusServer';
import { color, formatDuration, formatUtcMinutes, formatUtcSeconds } from './utils';

type Status = 'UP' | 'DOWN' | 'UNKNOWN';

interface Stats {
  totalChecks: number;
  totalFailures: number;
  successfulChecks: number;
  responseTimeSum: number;
  responseTimeCount: number;
  startedAt: Date;
}

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger({
    logDir: config.logDir,
    maxBytes: config.logMaxBytes,
    maxFiles: config.logMaxFiles,
  });
  const telegram = createTelegramClient({
    botToken: config.telegramBotToken,
    chatId: config.telegramChatId,
    apiBase: config.telegramApiBase,
    retries: config.telegramRetries,
    log: (level, message) => logger.event(level, message),
  });

  const monitor = new Monitor(config, logger, telegram);
  await monitor.start();
}

class Monitor {
  private status: Status = 'UNKNOWN';
  private consecutiveFailures = 0;
  private consecutiveSuccesses = 0;
  private downSince: Date | null = null;
  private rateLimitNotified = false;
  private running = true;

  private sleepTimer: NodeJS.Timeout | null = null;
  private wakeUp: (() => void) | null = null;
  private heartbeat: NodeJS.Timeout | null = null;
  private statusServer: StatusServer | null = null;

  private lastResult: CheckResult | null = null;
  private lastCheckAt: Date | null = null;

  private readonly stats: Stats = {
    totalChecks: 0,
    totalFailures: 0,
    successfulChecks: 0,
    responseTimeSum: 0,
    responseTimeCount: 0,
    startedAt: new Date(),
  };

  constructor(
    private readonly config: Config,
    private readonly logger: Logger,
    private readonly telegram: TelegramClient,
  ) {}

  async start(): Promise<void> {
    this.installSignalHandlers();

    if (this.config.statusPort > 0) {
      this.statusServer = startStatusServer(
        this.config.statusPort,
        () => this.snapshot(),
        this.logger,
      );
    }

    this.logger.event(
      'info',
      `Monitoring ${color.bold(this.config.siteUrl)} every ${Math.round(
        this.config.checkIntervalMs / 1000,
      )}s (timeout ${Math.round(this.config.timeoutMs / 1000)}s, ` +
        `down@${this.config.failuresToDown}, up@${this.config.successesToUp})`,
    );

    await this.telegram.send(
      `✅ Monitor started successfully.\n\n` +
        `Website:\n${this.config.siteUrl}\n\n` +
        `Interval:\n${Math.round(this.config.checkIntervalMs / 1000)}s\n\n` +
        `Started:\n${formatUtcMinutes(this.stats.startedAt)}`,
    );

    this.heartbeat = setInterval(() => {
      void this.sendHeartbeat();
    }, this.config.heartbeatIntervalMs);

    await this.loop();
  }

  // --- Main loop (recursive timeout avoids overlapping checks / drift) ---
  private async loop(): Promise<void> {
    while (this.running) {
      const startedAt = Date.now();
      try {
        await this.runCheck();
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        this.logger.event('error', `Unexpected check error: ${reason}`);
      }
      if (!this.running) break;
      const wait = Math.max(0, this.config.checkIntervalMs - (Date.now() - startedAt));
      await this.interruptibleSleep(wait);
    }
  }

  private async runCheck(): Promise<void> {
    const result = await check(this.config.siteUrl, {
      timeoutMs: this.config.timeoutMs,
      userAgent: this.config.userAgent,
    });

    this.lastResult = result;
    this.lastCheckAt = new Date();
    this.recordStats(result);
    this.logger.check({
      timestamp: new Date().toISOString(),
      status: result.status,
      code: result.httpCode,
      responseTimeMs: result.responseTimeMs,
      error: result.error,
      durationMs: result.durationMs,
    });
    this.printCheck(result);
    await this.handleRateLimit(result);
    await this.updateState(result);
  }

  private recordStats(result: CheckResult): void {
    this.stats.totalChecks++;
    if (result.ok) this.stats.successfulChecks++;
    else this.stats.totalFailures++;
    if (result.responseTimeMs != null) {
      this.stats.responseTimeSum += result.responseTimeMs;
      this.stats.responseTimeCount++;
    }
  }

  /** Rate-limit alert fires once per 429 episode (reset on any non-429 result). */
  private async handleRateLimit(result: CheckResult): Promise<void> {
    if (result.rateLimited) {
      if (!this.rateLimitNotified) {
        this.rateLimitNotified = true;
        await this.telegram.send(
          `🟠 RATE LIMIT DETECTED\n\n` +
            `Website:\n${this.config.siteUrl}\n\n` +
            `Status:\nHTTP ${result.httpCode ?? 429}\n\n` +
            `This may indicate Firebase/Auth/Hosting rate limiting.`,
        );
      }
    } else {
      this.rateLimitNotified = false;
    }
  }

  /** Debounced state machine: N failures -> DOWN, M successes -> UP. */
  private async updateState(result: CheckResult): Promise<void> {
    if (result.ok) {
      this.consecutiveSuccesses++;
      this.consecutiveFailures = 0;

      if (this.status !== 'UP' && this.consecutiveSuccesses >= this.config.successesToUp) {
        const wasDown = this.status === 'DOWN';
        const downtimeMs = this.downSince ? Date.now() - this.downSince.getTime() : 0;
        this.status = 'UP';
        this.downSince = null;
        if (wasDown) await this.notifyRecovered(result, downtimeMs);
      }
    } else {
      this.consecutiveFailures++;
      this.consecutiveSuccesses = 0;

      if (this.status !== 'DOWN' && this.consecutiveFailures >= this.config.failuresToDown) {
        this.status = 'DOWN';
        this.downSince = new Date();
        await this.notifyOffline(result);
      }
    }
  }

  private async notifyOffline(result: CheckResult): Promise<void> {
    await this.telegram.send(
      `🔴 WEBSITE OFFLINE\n\n` +
        `Website:\n${this.config.siteUrl}\n\n` +
        `Time:\n${formatUtcMinutes(new Date())}\n\n` +
        `Reason:\n${result.reason}\n\n` +
        `Response Time:\n${result.responseTimeMs != null ? `${result.responseTimeMs} ms` : '—'}\n\n` +
        `Consecutive failures:\n${this.consecutiveFailures}`,
    );
  }

  private async notifyRecovered(result: CheckResult, downtimeMs: number): Promise<void> {
    await this.telegram.send(
      `🟢 WEBSITE RECOVERED\n\n` +
        `Website:\n${this.config.siteUrl}\n\n` +
        `Recovered after:\n${formatDuration(downtimeMs)}\n\n` +
        `Current response:\n${result.reason}\n\n` +
        `Response time:\n${result.responseTimeMs != null ? `${result.responseTimeMs} ms` : '—'}`,
    );
  }

  private async sendHeartbeat(): Promise<void> {
    await this.telegram.send(
      `💙 Monitoring is running normally.\n\n` +
        `Website:\n${this.config.siteUrl}\n\n` +
        `Current status:\n${this.status}\n\n` +
        this.statsBlock(),
    );
    this.logger.event('info', 'Heartbeat sent.');
  }

  private uptimePct(): number {
    if (this.stats.totalChecks === 0) return 100;
    return (this.stats.successfulChecks / this.stats.totalChecks) * 100;
  }

  private avgResponseMs(): number | null {
    if (this.stats.responseTimeCount === 0) return null;
    return Math.round(this.stats.responseTimeSum / this.stats.responseTimeCount);
  }

  private statsBlock(): string {
    const avg = this.avgResponseMs();
    return (
      `Uptime: ${this.uptimePct().toFixed(2)}%\n` +
      `Avg response: ${avg == null ? '—' : `${avg} ms`}\n` +
      `Total checks: ${this.stats.totalChecks}\n` +
      `Total failures: ${this.stats.totalFailures}`
    );
  }

  /** Current state + rolling stats, served by the status API. */
  snapshot(): StatusSnapshot {
    return {
      status: this.status,
      site: this.config.siteUrl,
      lastCheck: {
        at: this.lastCheckAt ? this.lastCheckAt.toISOString() : null,
        status: this.lastResult?.status ?? null,
        httpCode: this.lastResult?.httpCode ?? null,
        responseTimeMs: this.lastResult?.responseTimeMs ?? null,
        reason: this.lastResult?.reason ?? null,
      },
      stats: {
        uptimePct: Number(this.uptimePct().toFixed(2)),
        avgResponseMs: this.avgResponseMs(),
        totalChecks: this.stats.totalChecks,
        totalFailures: this.stats.totalFailures,
        since: this.stats.startedAt.toISOString(),
      },
      updatedAt: new Date().toISOString(),
    };
  }

  private printCheck(result: CheckResult): void {
    const ts = color.gray(formatUtcSeconds(new Date()));
    const rt = color.gray(result.responseTimeMs != null ? `${result.responseTimeMs} ms` : '—');
    let label: string;
    if (result.ok) label = color.green(`● UP    ${result.reason}`);
    else if (result.rateLimited) label = color.yellow(`● RATE  ${result.reason}`);
    else label = color.red(`● DOWN  ${result.reason}`);
    console.log(`${ts}  ${label}  ${rt}`);
  }

  // --- Shutdown & sleep plumbing ---
  private interruptibleSleep(ms: number): Promise<void> {
    return new Promise<void>((resolve) => {
      this.sleepTimer = setTimeout(() => {
        this.sleepTimer = null;
        this.wakeUp = null;
        resolve();
      }, ms);
      this.wakeUp = (): void => {
        if (this.sleepTimer) clearTimeout(this.sleepTimer);
        this.sleepTimer = null;
        this.wakeUp = null;
        resolve();
      };
    });
  }

  private installSignalHandlers(): void {
    const shutdown = (signal: string): void => {
      void this.shutdown(signal);
    };
    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('uncaughtException', (err) => {
      this.logger.event('error', `uncaughtException: ${err.message}`);
    });
    process.on('unhandledRejection', (reason) => {
      this.logger.event('error', `unhandledRejection: ${String(reason)}`);
    });
  }

  private async shutdown(signal: string): Promise<void> {
    if (!this.running) return;
    this.running = false;
    this.logger.event('warn', `Received ${signal}, shutting down…`);

    if (this.heartbeat) clearInterval(this.heartbeat);
    if (this.statusServer) this.statusServer.close();
    if (this.wakeUp) this.wakeUp();

    await this.telegram
      .send(
        `🛑 Monitor stopped.\n\n` +
          `Website:\n${this.config.siteUrl}\n\n` +
          `Observed uptime:\n${this.uptimePct().toFixed(2)}%\n\n` +
          `Signal:\n${signal}`,
      )
      .catch(() => undefined);

    this.logger.close();
    process.exit(0);
  }
}

main().catch((err: unknown) => {
  const reason = err instanceof Error ? err.message : String(err);
  // Startup/config failure happens before the logger exists.
  console.error(`\x1b[31mFatal:\x1b[39m ${reason}`);
  process.exit(1);
});
