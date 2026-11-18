import http from 'node:http';
import type { AddressInfo } from 'node:net';

export interface TestServer {
  url: string;
  port: number;
  close(): Promise<void>;
}

export function listen(handler: http.RequestListener): Promise<TestServer> {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${port}`,
        port,
        close: () =>
          new Promise<void>((done) => {
            server.closeAllConnections();
            server.close(() => done());
          }),
      });
    });
  });
}

/** A port that nothing listens on: bind, read the port, close. */
export async function freePort(): Promise<number> {
  const s = await listen(() => undefined);
  await s.close();
  return s.port;
}

/** Fake Telegram Bot API that records every message text it receives. */
export async function fakeTelegram(
  respond: (call: number) => { status: number; body: unknown } = () => ({ status: 200, body: { ok: true } }),
): Promise<TestServer & { messages: string[]; calls: number }> {
  const state = { messages: [] as string[], calls: 0 };
  const server = await listen((req, res) => {
    let raw = '';
    req.on('data', (chunk) => (raw += chunk));
    req.on('end', () => {
      state.calls++;
      const { status, body } = respond(state.calls);
      if (status === 200) state.messages.push(JSON.parse(raw).text);
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    });
  });
  return {
    ...server,
    messages: state.messages,
    get calls() {
      return state.calls;
    },
  };
}

export async function waitFor(predicate: () => boolean, timeoutMs: number, what: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for: ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}
