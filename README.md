# pi-telegram-agent

Standalone Telegram frontend for Pi using the `@earendil-works/pi-coding-agent` SDK.

This replaces the older setup:

```text
systemd → screen → interactive pi → pi-telegram extension
```

with:

```text
systemd → bun run src/main.ts → Pi AgentSessionRuntime
```

## Features

- Loads normal Pi config from `~/.pi/agent`:
  - `settings.json`
  - `auth.json`
  - models
  - skills/extensions discovered by Pi's default resource loader
- Polls Telegram directly.
- Registers Telegram bot command suggestions:
  - `/new`
  - `/status`
  - `/compact`
  - `/stop`
  - `/help`
- `/new` calls `AgentSessionRuntime.newSession()` directly; no fake terminal or `screen` required.
- Streams assistant previews back to Telegram.
- Supports Telegram image/file downloads.
- Provides a `telegram_attach` tool so Pi can send generated files back to Telegram.

## Config

Uses the same config file as `pi-telegram`:

```text
~/.pi/agent/telegram.json
```

Minimum shape:

```json
{
  "botToken": "123456:ABC...",
  "allowedUserId": 123456789
}
```

If `allowedUserId` is omitted, the first Telegram DM user to message the bot is paired.

## Run locally

```bash
bun install
bun run start
```

Optional environment variables:

```bash
PI_TELEGRAM_CONFIG=~/.pi/agent/telegram.json
PI_TELEGRAM_TMP=~/.pi/agent/tmp/telegram-agent
PI_TELEGRAM_CWD=~
```

## Typecheck

```bash
bun run typecheck
```

## Example systemd user service

```ini
[Unit]
Description=Pi Telegram SDK agent
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=%h/Git/pi-telegram-agent
Environment=PATH=%h/.bun/bin:/usr/local/bin:/usr/bin:/bin
Environment=PI_TELEGRAM_CWD=%h
ExecStart=%h/.bun/bin/bun run src/main.ts
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
```

Then:

```bash
systemctl --user daemon-reload
systemctl --user enable --now pi-telegram-agent.service
loginctl enable-linger "$USER"
```
