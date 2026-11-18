import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTelegramClient } from '../src/telegram';
import { fakeTelegram } from './helpers';

const quiet = (): void => undefined;

test('sends the text to the chat and reports success', async () => {
  const api = await fakeTelegram();
  const client = createTelegramClient({ botToken: 't', chatId: '1', apiBase: api.url, retries: 3, log: quiet });
  assert.equal(await client.send('hello'), true);
  assert.deepEqual(api.messages, ['hello']);
  await api.close();
});

test("waits out Telegram's own 429 retry_after, then delivers", async () => {
  const api = await fakeTelegram((call) =>
    call === 1
      ? { status: 429, body: { ok: false, parameters: { retry_after: 0 } } }
      : { status: 200, body: { ok: true } },
  );
  const client = createTelegramClient({ botToken: 't', chatId: '1', apiBase: api.url, retries: 3, log: quiet });
  assert.equal(await client.send('after the limit'), true);
  assert.equal(api.calls, 2);
  assert.deepEqual(api.messages, ['after the limit']);
  await api.close();
});

test('gives up after the configured number of attempts', async () => {
  const api = await fakeTelegram(() => ({ status: 500, body: { ok: false } }));
  const logs: string[] = [];
  const client = createTelegramClient({
    botToken: 't',
    chatId: '1',
    apiBase: api.url,
    retries: 2,
    log: (_level, message) => logs.push(message),
  });
  assert.equal(await client.send('lost'), false);
  assert.equal(api.calls, 2);
  assert.ok(logs.some((l) => l.includes('gave up after 2 attempts')));
  await api.close();
});
