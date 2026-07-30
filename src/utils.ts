/**
 * Small, dependency-free helpers: ANSI colors, time/duration formatting, sleep.
 */

// Colors are disabled when output is piped (not a TTY) or NO_COLOR is set,
// so log files and PM2 captures stay clean.
const COLOR_ENABLED = !process.env.NO_COLOR && Boolean(process.stdout.isTTY);

type Colorizer = (s: string) => string;

function ansi(open: number, close: number): Colorizer {
  return (s: string): string => (COLOR_ENABLED ? `\x1b[${open}m${s}\x1b[${close}m` : s);
}

export const color = {
  green: ansi(32, 39),
  red: ansi(31, 39),
  yellow: ansi(33, 39),
  cyan: ansi(36, 39),
  gray: ansi(90, 39),
  bold: ansi(1, 22),
};

/** Format a Date as "YYYY-MM-DD HH:mm UTC" (matches the notification examples). */
export function formatUtcMinutes(d: Date): string {
  const [date, time] = d.toISOString().split('T');
  return `${date} ${time.slice(0, 5)} UTC`;
}

/** Format a Date as "YYYY-MM-DD HH:mm:ss UTC" for console/log lines. */
export function formatUtcSeconds(d: Date): string {
  const [date, time] = d.toISOString().split('T');
  return `${date} ${time.slice(0, 8)} UTC`;
}

/** Human-readable duration, e.g. 272_000 -> "4 minutes 32 seconds"; 187 -> "187 ms". */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} ms`;

  const totalSeconds = Math.floor(ms / 1000);
  const days = Math.floor(totalSeconds / 86_400);
  const hours = Math.floor((totalSeconds % 86_400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  const parts: string[] = [];
  if (days) parts.push(plural(days, 'day'));
  if (hours) parts.push(plural(hours, 'hour'));
  if (minutes) parts.push(plural(minutes, 'minute'));
  if (seconds || parts.length === 0) parts.push(plural(seconds, 'second'));
  return parts.join(' ');
}

function plural(n: number, unit: string): string {
  return `${n} ${unit}${n === 1 ? '' : 's'}`;
}

/** Promise-based delay. */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
