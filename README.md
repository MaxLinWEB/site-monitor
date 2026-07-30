# site-monitor

A lightweight, production-grade availability monitor. It checks your website on
a fixed interval, debounces transient blips so you don't get false alarms, and
pushes a Telegram message the moment the confirmed status changes.

> ⚠️ **Only monitor a site you own or are explicitly authorized to monitor.**
> This tool is meant for your own web application (e.g. your local/staging copy
> on `http://localhost:5000`, or a production domain you operate).

---

## Features

- **Interval checks** — every 30s by default (configurable), with a configurable timeout.
- **Precise failure classification** — online, HTTP 4xx/5xx, HTTP 429 (rate limit), network error, DNS failure, SSL/TLS error, timeout.
- **Smart debounce** — `FAILURES_TO_DOWN` consecutive failures → **OFFLINE**; `SUCCESSES_TO_UP` consecutive successes → **ONLINE**. No alert on a single blip.
- **Telegram alerts on state change only** — offline, recovered (with downtime), and a dedicated rate-limit alert.
- **Startup + daily heartbeat** messages.
- **Status API** — optional `GET /status` (JSON) and `GET /health` endpoints, auto-enabled on hosts that inject `$PORT`.
- **Statistics** — uptime %, average response time, total checks, total failures (in the heartbeat and `/status`).
- **Rotating file log** — every check is written as JSONL to `logs/monitor.log`, rotated by size.
- **Colored console output** with human-readable UTC timestamps.
- **Graceful shutdown** on `SIGINT`/`SIGTERM`, retried Telegram delivery, no socket/memory leaks.
- **TypeScript, strict mode**, zero runtime dependencies beyond `dotenv`.

---

## Requirements

- **Node.js ≥ 18** (uses the built-in global `fetch`).

---

## Installation

```bash
cd monitor
npm install
cp .env.example .env
# then edit .env (see Configuration below)
```

---

## Configuration

All configuration is via `.env`:

| Variable             | Required | Default        | Description                                             |
| -------------------- | :------: | -------------- | ------------------------------------------------------- |
| `SITE_URL`           |    ✅    | —              | URL to monitor. Must be a site you own/are authorized on. |
| `CHECK_INTERVAL`     |          | `30000`        | Milliseconds between checks.                            |
| `TIMEOUT`            |          | `10000`        | Per-request timeout in ms.                              |
| `FAILURES_TO_DOWN`   |          | `3`            | Consecutive failures before declaring OFFLINE.          |
| `SUCCESSES_TO_UP`    |          | `2`            | Consecutive successes before declaring ONLINE.          |
| `TELEGRAM_BOT_TOKEN` |    ✅    | —              | Bot token from @BotFather.                              |
| `TELEGRAM_CHAT_ID`   |    ✅    | —              | Chat/channel ID to notify.                              |
| `HEARTBEAT_INTERVAL` |          | `86400000`     | Daily heartbeat interval in ms.                         |
| `LOG_DIR`            |          | `logs`         | Directory for log files.                                |
| `LOG_MAX_BYTES`      |          | `5242880`      | Rotate the log past this size (5 MB).                   |
| `LOG_MAX_FILES`      |          | `5`            | Number of rotated log files to keep.                    |
| `TELEGRAM_RETRIES`   |          | `3`            | Retry attempts for a failed Telegram send.              |
| `USER_AGENT`         |          | `site-monitor/1.0` | User-Agent header sent with each check.             |

The process **fails fast at startup** with a clear message if a required value
is missing or malformed (e.g. a bad `SITE_URL`).

---

## Telegram bot setup

1. In Telegram, open a chat with **[@BotFather](https://t.me/BotFather)**.
2. Send `/newbot` and follow the prompts (name + username).
3. BotFather replies with a **token** like `123456789:AAExxxxxxxxxxxxxxxxxxxxxxxxx`.
   Put it in `.env` as `TELEGRAM_BOT_TOKEN`.
4. **Send your bot a message** (say `hi`). A bot cannot message you until you've
   started a conversation with it.

### Obtaining your Chat ID

**Option A — via the API (simplest):**

After sending your bot a message, open this URL in a browser (replace `<TOKEN>`):

```
https://api.telegram.org/bot<TOKEN>/getUpdates
```

Find `"chat":{"id":...}` in the JSON — that number is your `TELEGRAM_CHAT_ID`.
(For a personal chat it's positive; for a group/channel it's negative, e.g. `-100…`.)

**Option B — via a helper bot:**

Message **[@userinfobot](https://t.me/userinfobot)**; it replies with your numeric ID.

**Sending to a channel:** add the bot as an **admin** of the channel, then use the
channel's ID (or `@channelusername`) as `TELEGRAM_CHAT_ID`.

Quick sanity check that credentials work:

```bash
curl "https://api.telegram.org/bot<TOKEN>/sendMessage?chat_id=<CHAT_ID>&text=hello"
```

---

## Running

### Development (auto-reload)

```bash
npm run dev
```

Runs `src/index.ts` directly with `tsx` and restarts on file changes.

### Production

```bash
npm run build   # compiles TypeScript to dist/
npm start       # runs node dist/index.js
```

### With PM2

[PM2](https://pm2.keymetrics.io/) keeps the monitor running across crashes and reboots.

```bash
npm install -g pm2
npm run build

# start it
pm2 start dist/index.js --name site-monitor

# handy commands
pm2 logs site-monitor      # stream console output
pm2 restart site-monitor
pm2 stop site-monitor
pm2 delete site-monitor

# survive reboots
pm2 save
pm2 startup                # run the command it prints
```

PM2 sends `SIGINT`/`SIGTERM` on stop/restart, which the monitor handles
gracefully (it flushes logs and sends a "Monitor stopped" message).

---

## What the alerts look like

**Offline**

```
🔴 WEBSITE OFFLINE

Website:
http://localhost:5000

Time:
2026-07-30 13:45 UTC

Reason:
HTTP 500

Response Time:
—

Consecutive failures:
3
```

**Recovered**

```
🟢 WEBSITE RECOVERED

Website:
http://localhost:5000

Recovered after:
4 minutes 32 seconds

Current response:
200 OK

Response time:
187 ms
```

**Rate limit**

```
🟠 RATE LIMIT DETECTED

Website:
http://localhost:5000

Status:
HTTP 429

This may indicate Firebase/Auth/Hosting rate limiting.
```

---

## Status API

When a port is available the monitor also exposes a tiny read-only HTTP API — it
turns on automatically when the host injects `$PORT` (Railway/Render/Fly), or set
`STATUS_PORT` locally.

| Endpoint  | Purpose | Response |
| --------- | ------- | -------- |
| `GET /status` | Current state + rolling stats (JSON) | `200` when UP/UNKNOWN, **`503` when DOWN** |
| `GET /health` | Liveness of the **monitor process** | always `200` while running |

`/health` deliberately reflects the *monitor*, not the monitored site, so an
outage of your website never makes the platform restart the monitor.

```bash
curl http://localhost:3000/status
```

```json
{
  "status": "UP",
  "site": "https://your-site.example",
  "lastCheck": { "at": "2026-07-30T13:45:12.345Z", "status": "online", "httpCode": 200, "responseTimeMs": 187, "reason": "200 OK" },
  "stats": { "uptimePct": 99.94, "avgResponseMs": 190, "totalChecks": 2880, "totalFailures": 2, "since": "2026-07-29T13:45:00.000Z" },
  "updatedAt": "2026-07-30T13:45:12.500Z"
}
```

---

## Deploying 24/7 to a server

> The monitor must be able to **reach** `SITE_URL`. `http://localhost:5000` only
> works on your own machine — on a remote server point `SITE_URL` at a **public
> URL you own or are authorized to monitor**.

### Railway (Dockerfile + healthcheck included)

`Dockerfile` and `railway.json` are already in this folder (`railway.json` sets
the `/health` healthcheck). Railway injects `$PORT`, so the status API turns on
automatically.

```bash
npm i -g @railway/cli
railway login
railway init                       # create/select a project
railway up                         # build & deploy this folder

# set the runtime variables (or do it in the dashboard → Variables)
railway variables \
  --set "SITE_URL=https://your-site.example" \
  --set "TELEGRAM_BOT_TOKEN=123:ABC" \
  --set "TELEGRAM_CHAT_ID=123456789"
```

Railway keeps it running, restarts on failure, and survives redeploys. Logs:
`railway logs`.

### Docker (any VPS)

```bash
docker build -t site-monitor .
docker run -d --name site-monitor --restart unless-stopped \
  -e SITE_URL=https://your-site.example \
  -e TELEGRAM_BOT_TOKEN=123:ABC \
  -e TELEGRAM_CHAT_ID=123456789 \
  -e PORT=3000 -p 3000:3000 \
  -v "$PWD/logs:/app/logs" \
  site-monitor
```

### systemd (bare VPS, no Docker)

```ini
# /etc/systemd/system/site-monitor.service
[Unit]
Description=site-monitor
After=network-online.target

[Service]
WorkingDirectory=/opt/site-monitor
ExecStart=/usr/bin/node dist/index.js
EnvironmentFile=/opt/site-monitor/.env
Restart=always
RestartSec=5
User=www-data

[Install]
WantedBy=multi-user.target
```

```bash
# build locally or on the box first: npm ci && npm run build
sudo systemctl daemon-reload
sudo systemctl enable --now site-monitor
journalctl -u site-monitor -f      # follow logs
```

`Restart=always` + `systemctl enable` gives you 24/7 with auto-restart on crash
or reboot. `SIGTERM` from systemd is handled gracefully.

### Oracle Cloud Free Tier (ARM/x86 VPS) — step by step

Works on both the Ampere A1 (ARM64) and the AMD micro shapes; the monitor has no
native dependencies.

**1. SSH in** (user depends on the image):

```bash
ssh ubuntu@<public-ip>     # Ubuntu image
ssh opc@<public-ip>        # Oracle Linux image
```

**2. Install Node 20** (NodeSource has ARM64 + x86 builds):

```bash
# Ubuntu
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs
# Oracle Linux
# curl -fsSL https://rpm.nodesource.com/setup_20.x | sudo bash -
# sudo dnf install -y nodejs
```

**3. Copy this folder to the server** (run from your machine):

```bash
rsync -av --exclude node_modules --exclude dist --exclude logs \
  "monitor/" ubuntu@<public-ip>:/opt/site-monitor/
```

**4. Build & configure on the box:**

```bash
cd /opt/site-monitor
npm ci
npm run build
cp .env.example .env
nano .env          # set SITE_URL (public!) + TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID
```

**5. Install the systemd service** (use the unit above; set `User=ubuntu` or
`opc`, `WorkingDirectory=/opt/site-monitor`):

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now site-monitor
journalctl -u site-monitor -f
```

**Outbound traffic works by default on Oracle** — the checks and Telegram
notifications need *nothing* opened. You'll get the startup message on Telegram
within seconds.

**6. (Optional) expose the status API to the internet.** Oracle blocks inbound
in **two** places — you must open both:

- **VCN**: Networking → your VCN → Security List (or the instance's NSG) → add an
  **Ingress rule**: Source `0.0.0.0/0` (or just your IP), IP Protocol TCP,
  Destination Port = your `STATUS_PORT` (e.g. `3000`).
- **OS firewall**:
  ```bash
  # Ubuntu (iptables)
  sudo iptables -I INPUT 6 -p tcp --dport 3000 -j ACCEPT
  sudo netfilter-persistent save
  # Oracle Linux (firewalld)
  # sudo firewall-cmd --permanent --add-port=3000/tcp && sudo firewall-cmd --reload
  ```

Then `http://<public-ip>:3000/status` is reachable. It's read-only (up/down +
stats), but restrict the source CIDR if you'd rather keep it private.

---

## Logs

Each check is appended to `logs/monitor.log` as one JSON object per line:

```json
{"timestamp":"2026-07-30T13:45:12.345Z","status":"online","code":200,"responseTimeMs":187,"error":null,"durationMs":190}
```

When the file passes `LOG_MAX_BYTES` it's rotated to `monitor.log.1`,
`monitor.log.2`, … up to `LOG_MAX_FILES`; the oldest is discarded.

Inspect recent activity:

```bash
tail -f logs/monitor.log
```

---

## Troubleshooting

| Symptom | Likely cause / fix |
| --- | --- |
| `Fatal: Missing required env var SITE_URL` | `.env` not created or value empty. `cp .env.example .env` and fill it in. |
| `Fatal: SITE_URL is not a valid URL` | Include the scheme, e.g. `https://example.com`, not `example.com`. |
| No Telegram messages arrive | You never messaged the bot first; or wrong `TELEGRAM_CHAT_ID`; verify with the `curl` sanity check above. |
| `Telegram send failed: HTTP 401` | Wrong/expired `TELEGRAM_BOT_TOKEN`. |
| `Telegram send failed: HTTP 400 ... chat not found` | Wrong `TELEGRAM_CHAT_ID`, or bot isn't a member/admin of the target group/channel. |
| Constant "OFFLINE" for a local URL | Your local server isn't running on `SITE_URL`; start it first (e.g. `firebase serve` → `http://localhost:5000`). |
| Every check is `ssl_error` | Self-signed/expired cert. Use `http://` for a local server, or fix the certificate. |
| Alerts feel too sensitive/slow | Tune `FAILURES_TO_DOWN` / `SUCCESSES_TO_UP` and `CHECK_INTERVAL`. |
| `fetch is not defined` | Node < 18. Upgrade Node. |

---

## Design notes

- **Why no per-request retries in the checker?** The consecutive-failure
  threshold (`FAILURES_TO_DOWN`) *is* the debounce — it's a better signal for
  availability than silently retrying a single request. Retries with backoff are
  applied where they actually matter: **delivering Telegram notifications**.
- **Native `http`/`https`** (not `fetch`) is used for checks so DNS, TLS, socket
  and timeout failures can be told apart precisely; the body is drained and
  discarded so each check stays cheap and leak-free.
- **Recursive `setTimeout`** (not `setInterval`) drives the loop, so a slow check
  can never overlap the next one or let timers pile up.
