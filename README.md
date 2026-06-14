# pi-telegram-agent

Standalone Telegram frontend for Pi using the `@earendil-works/pi-coding-agent` SDK.

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
  - `/model`
  - `/stop`
  - `/help`
- Starts by continuing the most recent Pi session for `PI_TELEGRAM_CWD`, so systemd restarts keep chat history.
- `/new` calls `AgentSessionRuntime.newSession()` directly; no fake terminal or `screen` required.
- `/model` opens a Telegram inline keyboard to select or search any authenticated Pi model, sorted by OpenRouter weekly popularity when available.
- Streams assistant previews back to Telegram, using Bot API 10.1 rich message drafts when available.
- Sends assistant output as Bot API 10.1 rich Markdown messages when available (headings, lists, tables, media blocks, quotes, footnotes, formulas, and nested formatting), with automatic fallback to legacy Telegram HTML formatting.
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
EXA_API_KEY=...
```

`PI_TELEGRAM_TMP` controls where files downloaded from Telegram are stored before being passed to Pi. If unset, it defaults to `~/.pi/agent/tmp/telegram-agent`.

`PI_TELEGRAM_CWD` controls the working directory for the Pi agent session, including where commands run and how relative paths are resolved. If unset, it defaults to the directory where this process is started.

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
# Optional: load secrets/env vars needed by Pi skills/tools, such as EXA_API_KEY.
EnvironmentFile=-%h/.pi/agent/telegram-agent.env
ExecStart=%h/.bun/bin/bun run src/main.ts
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
```

If you need API keys from your shell (for example `EXA_API_KEY`), do not rely on `~/.zshrc`: systemd services do not load interactive shell startup files. Put them in the env file referenced above instead:

```bash
mkdir -p ~/.pi/agent
printf 'EXA_API_KEY=%s\n' 'your-key-here' > ~/.pi/agent/telegram-agent.env
chmod 600 ~/.pi/agent/telegram-agent.env
```

Then:

```bash
systemctl --user daemon-reload
systemctl --user enable --now pi-telegram-agent.service
loginctl enable-linger "$USER"
```
