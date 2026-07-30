/**
 * Single-shot availability check.
 *
 * Uses Node's native http/https so every failure mode can be classified
 * precisely (DNS, TLS/SSL, network, timeout, HTTP status). `check()` NEVER
 * throws — every outcome is returned as a typed CheckResult. The consecutive
 * failure/success debounce lives in index.ts; a single check is intentionally
 * a single request (lightweight, no retries) so the debounce is the source of
 * truth for state changes.
 */
import http from 'node:http';
import https from 'node:https';
import type { RequestOptions } from 'node:http';

export type CheckStatus =
  | 'online'
  | 'http_error'
  | 'rate_limited'
  | 'network_error'
  | 'dns_error'
  | 'ssl_error'
  | 'timeout';

export interface CheckResult {
  ok: boolean;
  status: CheckStatus;
  httpCode: number | null;
  responseTimeMs: number | null;
  /** Short human-readable reason, e.g. "HTTP 500", "200 OK", "DNS lookup failed". */
  reason: string;
  rateLimited: boolean;
  /** Raw error detail for the log file; null on success. */
  error: string | null;
  /** Total wall-clock time spent on this check. */
  durationMs: number;
}

export interface CheckOptions {
  timeoutMs: number;
  userAgent: string;
}

const SSL_ERROR_CODES = new Set([
  'CERT_HAS_EXPIRED',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'ERR_TLS_CERT_ALTNAME_INVALID',
  'CERT_UNTRUSTED',
  'ERR_SSL_WRONG_VERSION_NUMBER',
  'ERR_TLS_HANDSHAKE_TIMEOUT',
]);

const DNS_ERROR_CODES = new Set(['ENOTFOUND', 'EAI_AGAIN']);

/** Marker error so the timeout path is distinguishable from generic socket errors. */
class TimeoutError extends Error {
  constructor(public readonly timeoutMs: number) {
    super(`Timeout after ${timeoutMs} ms`);
    this.name = 'TimeoutError';
  }
}

export function check(url: string, opts: CheckOptions): Promise<CheckResult> {
  return new Promise<CheckResult>((resolve) => {
    const startedNs = process.hrtime.bigint();
    const elapsedMs = (): number => Number(process.hrtime.bigint() - startedNs) / 1_000_000;

    let settled = false;
    const finish = (partial: Omit<CheckResult, 'durationMs'>): void => {
      if (settled) return;
      settled = true;
      resolve({ ...partial, durationMs: Math.round(elapsedMs()) });
    };

    const target = new URL(url);
    const options: RequestOptions = {
      method: 'GET',
      headers: {
        'User-Agent': opts.userAgent,
        Accept: '*/*',
        // Avoid keep-alive so sockets are released promptly (no FD/memory leak).
        Connection: 'close',
      },
      timeout: opts.timeoutMs,
    };

    const onResponse = (res: http.IncomingMessage): void => {
      const responseTimeMs = Math.round(elapsedMs());
      const code = res.statusCode ?? 0;
      // Drain and discard the body so the socket can close; we only need status.
      res.resume();

      if (code === 429) {
        finish({
          ok: false,
          status: 'rate_limited',
          httpCode: code,
          responseTimeMs,
          reason: 'HTTP 429',
          rateLimited: true,
          error: 'HTTP 429 Too Many Requests',
        });
        return;
      }
      if (code >= 400) {
        finish({
          ok: false,
          status: 'http_error',
          httpCode: code,
          responseTimeMs,
          reason: `HTTP ${code}`,
          rateLimited: false,
          error: `HTTP ${code} ${res.statusMessage ?? ''}`.trim(),
        });
        return;
      }
      // Anything below 400 (2xx/3xx) means the server answered: online.
      finish({
        ok: true,
        status: 'online',
        httpCode: code,
        responseTimeMs,
        reason: `${code} ${res.statusMessage ?? 'OK'}`.trim(),
        rateLimited: false,
        error: null,
      });
    };

    // Branch instead of a union callable so TS keeps precise http/https typings.
    const req =
      target.protocol === 'http:'
        ? http.request(target, options, onResponse)
        : https.request(target, options, onResponse);

    req.on('timeout', () => {
      // Node emits 'timeout' but does not abort the request; destroy it so the
      // 'error' handler runs with our marker error.
      req.destroy(new TimeoutError(opts.timeoutMs));
    });

    req.on('error', (err: NodeJS.ErrnoException) => {
      finish(classifyError(err, opts.timeoutMs));
    });

    req.end();
  });
}

function classifyError(
  err: NodeJS.ErrnoException,
  timeoutMs: number,
): Omit<CheckResult, 'durationMs'> {
  if (err instanceof TimeoutError) {
    return failure('timeout', `Timeout after ${timeoutMs} ms`, err.message);
  }
  const code = err.code ?? '';
  if (code === 'ETIMEDOUT') {
    return failure('timeout', 'Connection timed out', describe(err));
  }
  if (DNS_ERROR_CODES.has(code)) {
    return failure('dns_error', `DNS lookup failed (${code})`, describe(err));
  }
  if (SSL_ERROR_CODES.has(code) || code.startsWith('ERR_TLS') || code.includes('CERT')) {
    return failure('ssl_error', `SSL/TLS error (${code})`, describe(err));
  }
  // ECONNREFUSED, ECONNRESET, EHOSTUNREACH, ENETUNREACH, EPIPE, EPROTO, …
  return failure('network_error', `Network error (${code || err.message})`, describe(err));
}

function failure(
  status: CheckStatus,
  reason: string,
  error: string,
): Omit<CheckResult, 'durationMs'> {
  return {
    ok: false,
    status,
    httpCode: null,
    responseTimeMs: null,
    reason,
    rateLimited: false,
    error,
  };
}

function describe(err: NodeJS.ErrnoException): string {
  return `${err.code ?? err.name}: ${err.message}`;
}
