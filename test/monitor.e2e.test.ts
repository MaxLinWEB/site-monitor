/**
 * End to end: runs the real monitor process against a local site whose answer
 * we control, with alerts going to a fake Telegram API.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fakeTelegram, freePort, listen, waitFor } from './helpers';

test('debounces, alerts on real state changes, serves /status and stops cleanly', async () => {
  let mode: 'ok' | 'fail' | 'blip' | 'limit' = 'ok';
  const site = await listen((_req, res) => {
    if (mode === 'blip') {
      mode = 'ok'; // fail exactly one check
      res.writeHead(500);
    } else {
      res.writeHead(mode === 'ok' ? 200 : mode === 'limit' ? 429 : 500);
    }
    res.end();
  });
  const telegram = await fakeTelegram();
  const statusPort = await freePort();
  const interval = 100;

  const child = spawn(process.execPath, ['--import', 'tsx', path.join(__dirname, '..', 'src', 'index.ts')], {
    env: {
      ...process.env,
      PORT: '',
      SITE_URL: site.url,
      CHECK_INTERVAL: String(interval),
      TIMEOUT: '1000',
      FAILURES_TO_DOWN: '3',
      SUCCESSES_TO_UP: '2',
      TELEGRAM_BOT_TOKEN: 'test-token',
      TELEGRAM_CHAT_ID: '42',
      TELEGRAM_API_BASE: telegram.url,
      STATUS_PORT: String(statusPort),
      LOG_DIR: mkdtempSync(path.join(tmpdir(), 'site-monitor-')),
      NO_COLOR: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (d) => (output += d));
  child.stderr.on('data', (d) => (output += d));
  const exited = new Promise<number | null>((resolve) => child.on('exit', resolve));
  const has = (text: string): number => telegram.messages.filter((m) => m.includes(text)).length;
  const status = async (): Promise<{ code: number; body: { status: string } }> => {
    const res = await fetch(`http://127.0.0.1:${statusPort}/status`);
    return { code: res.status, body: (await res.json()) as { status: string } };
  };

  try {
    await waitFor(() => has('Monitor started') === 1, 10_000, 'startup message');
    await waitFor(() => output.includes('UP    200'), 5_000, 'first successful check');

    // One failed check is a blip: no alert.
    mode = 'blip';
    await new Promise((r) => setTimeout(r, interval * 6));
    assert.equal(has('WEBSITE OFFLINE'), 0, 'a single failure must not alert');

    // Sustained failure: exactly one OFFLINE alert, after the third failure.
    mode = 'fail';
    await waitFor(() => has('WEBSITE OFFLINE') === 1, 5_000, 'offline alert');
    const offline = telegram.messages.find((m) => m.includes('WEBSITE OFFLINE'))!;
    assert.match(offline, /Reason:\nHTTP 500/);
    assert.match(offline, /Consecutive failures:\n3/);
    const down = await status();
    assert.equal(down.code, 503);
    assert.equal(down.body.status, 'DOWN');
    await new Promise((r) => setTimeout(r, interval * 4));
    assert.equal(has('WEBSITE OFFLINE'), 1, 'no repeat alerts while still down');

    // Back up: one RECOVERED alert with the downtime.
    mode = 'ok';
    await waitFor(() => has('WEBSITE RECOVERED') === 1, 5_000, 'recovered alert');
    assert.match(telegram.messages.find((m) => m.includes('WEBSITE RECOVERED'))!, /Recovered after:\n/);
    assert.equal((await status()).code, 200);

    // 429s: one rate-limit alert per episode.
    mode = 'limit';
    await waitFor(() => has('RATE LIMIT DETECTED') === 1, 5_000, 'rate-limit alert');
    await new Promise((r) => setTimeout(r, interval * 4));
    assert.equal(has('RATE LIMIT DETECTED'), 1, 'rate-limit alert fires once per episode');
    mode = 'ok';

    child.kill('SIGTERM');
    assert.equal(await exited, 0);
    assert.equal(has('Monitor stopped'), 1);
  } catch (err) {
    child.kill('SIGKILL');
    throw new Error(`${(err as Error).message}\n--- monitor output ---\n${output}`);
  } finally {
    await site.close();
    await telegram.close();
  }
});
