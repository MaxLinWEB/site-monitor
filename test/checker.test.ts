import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { check } from '../src/checker';
import { freePort, listen, type TestServer } from './helpers';

const opts = { timeoutMs: 300, userAgent: 'site-monitor-test' };

let server: TestServer;
before(async () => {
  server = await listen((req, res) => {
    if (req.url === '/slow') {
      setTimeout(() => res.end('late'), 1_000);
      return;
    }
    const code = Number(req.url?.slice(1)) || 200;
    res.writeHead(code);
    res.end();
  });
});
after(() => server.close());

test('2xx and 3xx count as online', async () => {
  for (const code of [200, 204, 301]) {
    const r = await check(`${server.url}/${code}`, opts);
    assert.equal(r.ok, true, `HTTP ${code}`);
    assert.equal(r.status, 'online');
    assert.equal(r.httpCode, code);
    assert.ok(r.responseTimeMs !== null && r.responseTimeMs >= 0);
  }
});

test('4xx and 5xx are http_error with the code in the reason', async () => {
  const r = await check(`${server.url}/503`, opts);
  assert.equal(r.ok, false);
  assert.equal(r.status, 'http_error');
  assert.equal(r.reason, 'HTTP 503');
  assert.equal(r.rateLimited, false);
});

test('429 is reported as rate_limited, not a plain http_error', async () => {
  const r = await check(`${server.url}/429`, opts);
  assert.equal(r.ok, false);
  assert.equal(r.status, 'rate_limited');
  assert.equal(r.rateLimited, true);
});

test('a response slower than the timeout is a timeout', async () => {
  const r = await check(`${server.url}/slow`, opts);
  assert.equal(r.status, 'timeout');
  assert.match(r.reason, /Timeout after 300 ms/);
  assert.ok(r.durationMs < 900, `gave up after ${r.durationMs} ms`);
});

test('a closed port is a network_error', async () => {
  const r = await check(`http://127.0.0.1:${await freePort()}/`, opts);
  assert.equal(r.status, 'network_error');
  assert.match(r.reason, /ECONNREFUSED/);
});

test('an unresolvable host is a dns_error', async () => {
  const r = await check('http://site-monitor-test.invalid/', { ...opts, timeoutMs: 5_000 });
  assert.equal(r.status, 'dns_error');
});
