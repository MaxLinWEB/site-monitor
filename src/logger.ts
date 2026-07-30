/**
 * Logging: per-check JSONL to `logs/monitor.log` with size-based rotation, plus
 * colored, timestamped console output for operational events.
 */
import fs from 'node:fs';
import path from 'node:path';
import { color, formatUtcSeconds } from './utils';

export type LogLevel = 'info' | 'warn' | 'error';

export interface CheckLogEntry {
  timestamp: string;
  status: string;
  code: number | null;
  responseTimeMs: number | null;
  error: string | null;
  durationMs: number;
}

export interface Logger {
  /** Append one check result to the rotating log file. */
  check(entry: CheckLogEntry): void;
  /** Print an operational event to the console (info/warn/error). */
  event(level: LogLevel, message: string): void;
  close(): void;
}

export interface LoggerOptions {
  logDir: string;
  maxBytes: number;
  maxFiles: number;
}

export function createLogger(opts: LoggerOptions): Logger {
  fs.mkdirSync(opts.logDir, { recursive: true });
  const logFile = path.join(opts.logDir, 'monitor.log');

  let stream = fs.createWriteStream(logFile, { flags: 'a' });
  let size = safeSize(logFile);

  function rotateIfNeeded(nextBytes: number): void {
    if (size + nextBytes < opts.maxBytes) return;

    stream.end();
    // monitor.log.(n-1) -> .n, …, monitor.log -> monitor.log.1; oldest is dropped.
    for (let i = opts.maxFiles; i >= 1; i--) {
      const from = i === 1 ? logFile : `${logFile}.${i - 1}`;
      const to = `${logFile}.${i}`;
      if (fs.existsSync(from)) {
        try {
          fs.renameSync(from, to);
        } catch {
          /* best-effort: never let rotation crash the monitor */
        }
      }
    }
    stream = fs.createWriteStream(logFile, { flags: 'a' });
    size = 0;
  }

  function check(entry: CheckLogEntry): void {
    const line = JSON.stringify(entry) + '\n';
    const bytes = Buffer.byteLength(line);
    rotateIfNeeded(bytes);
    stream.write(line);
    size += bytes;
  }

  function event(level: LogLevel, message: string): void {
    const ts = color.gray(formatUtcSeconds(new Date()));
    const tag =
      level === 'error'
        ? color.red('ERROR')
        : level === 'warn'
          ? color.yellow('WARN ')
          : color.cyan('INFO ');
    const line = `${ts} ${tag} ${message}`;
    if (level === 'error') console.error(line);
    else console.log(line);
  }

  function close(): void {
    stream.end();
  }

  return { check, event, close };
}

function safeSize(file: string): number {
  try {
    return fs.statSync(file).size;
  } catch {
    return 0;
  }
}
