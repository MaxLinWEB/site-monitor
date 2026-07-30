/**
 * Optional HTTP status API.
 *
 * Turns the monitor into a queryable "status service" and gives a hosting
 * platform a health endpoint to hit:
 *   GET /status  -> JSON snapshot (200 when UP/UNKNOWN, 503 when DOWN)
 *   GET /health  -> 200 while the MONITOR process is alive (NOT the target),
 *                   so an outage of the monitored site never makes the platform
 *                   restart the monitor itself.
 */
import http from 'node:http';
import type { Logger } from './logger';

export interface StatusSnapshot {
  status: 'UP' | 'DOWN' | 'UNKNOWN';
  site: string;
  lastCheck: {
    at: string | null;
    status: string | null;
    httpCode: number | null;
    responseTimeMs: number | null;
    reason: string | null;
  };
  stats: {
    uptimePct: number;
    avgResponseMs: number | null;
    totalChecks: number;
    totalFailures: number;
    since: string;
  };
  updatedAt: string;
}

export interface StatusServer {
  close(): void;
}

export function startStatusServer(
  port: number,
  getSnapshot: () => StatusSnapshot,
  logger: Logger,
): StatusServer {
  const server = http.createServer((req, res) => {
    const pathname = (req.url ?? '/').split('?')[0];

    if (req.method !== 'GET') {
      res.writeHead(405, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'method not allowed' }));
      return;
    }

    if (pathname === '/health' || pathname === '/healthz') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, service: 'site-monitor' }));
      return;
    }

    if (pathname === '/' || pathname === '/status') {
      const snapshot = getSnapshot();
      const code = snapshot.status === 'DOWN' ? 503 : 200;
      res.writeHead(code, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(snapshot, null, 2));
      return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'not found' }));
  });

  server.on('error', (err) => {
    logger.event('error', `Status server error: ${err.message}`);
  });

  server.listen(port, () => {
    logger.event('info', `Status API listening on :${port} (GET /status, /health)`);
  });

  return {
    close: (): void => {
      server.close();
    },
  };
}
