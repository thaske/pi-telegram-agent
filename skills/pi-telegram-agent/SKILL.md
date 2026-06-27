# pi-telegram-agent

This skill provides operational knowledge about the **pi-telegram-agent** project: a standalone Telegram frontend for Pi powered by the `@earendil-works/pi-coding-agent` SDK.

The repo lives at `~/Git/pi-telegram-agent`. The agent runs as a **systemd user service** (`pi-telegram-agent.service`).

## Architecture

- `systemd --user` → `bun run src/main.ts` → `Pi AgentSessionRuntime`
- Polls Telegram directly via `getUpdates`.
- Loads normal Pi config from `~/.pi/agent/` (`settings.json`, `auth.json`, models, extensions).
- Config file is `~/.pi/agent/telegram.json`.
- Optional env vars:
  - `PI_TELEGRAM_CONFIG` (defaults to `~/.pi/agent/telegram.json`)
  - `PI_TELEGRAM_TMP` (defaults to `~/.pi/agent/tmp/telegram-agent`)
  - `PI_TELEGRAM_CWD` (defaults to process start directory; often set to `%h` = `$HOME` in systemd)
  - `EXA_API_KEY` (loaded via `EnvironmentFile=-%h/.pi/agent/telegram-agent.env` in systemd)

## Startup Behavior

On every startup, the bot checks for a `pending-turn.json` file in `TEMP_DIR` (defaults to `~/.pi/agent/tmp/telegram-agent`). If present, it means the bot was restarted **mid-turn** — the turn is restored to the queue and automatically resumed once the session is idle.

This covers the case where the process was restarted via systemd **after** receiving a message but **before** sending the reply. Telegram's `getUpdates` offset handles messages that arrived while the bot was offline, but it cannot recover an update that was already acknowledged and then lost mid-processing. The pending-turn persistence closes that gap.

## Registered Telegram Commands

The bot registers these command suggestions with Telegram:

- `/new` — Start a new Pi chat
- `/status` — Show model, usage, and context
- `/model` — Choose the active Pi model
- `/compact` — Compact the current Pi chat
- `/stop` — Abort the active Pi turn

## systemd Quick Reference

**Status**

```bash
systemctl --user status pi-telegram-agent.service
```

**Restart / Reload**

```bash
systemctl --user restart pi-telegram-agent.service
```

**View logs**

```bash
journalctl --user -u pi-telegram-agent.service -f
```

**Enable on boot**

```bash
systemctl --user enable pi-telegram-agent.service
loginctl enable-linger "$USER"
```

## Key Files

| File                                          | Purpose                                            |
| --------------------------------------------- | -------------------------------------------------- |
| `~/Git/pi-telegram-agent/src/main.ts`         | Entry point                                        |
| `~/Git/pi-telegram-agent/src/bridge.ts`       | Telegram ↔ Pi bridge logic, command dispatch       |
| `~/Git/pi-telegram-agent/src/telegram/api.ts` | Telegram Bot API wrapper, `setMyCommands`          |
| `~/.pi/agent/telegram.json`                   | Bot token, allowed user ID                         |
| `~/.pi/agent/telegram-agent.env`              | Optional env-file for secrets (e.g. `EXA_API_KEY`) |

## When the user asks

- "restart the bot" → use `systemctl --user restart pi-telegram-agent.service`
- "reload the bot" → same as restart (systemd `Type=simple`, no SIGHUP handler)
- "show logs" → `journalctl --user -u pi-telegram-agent.service -f`
- "what commands are available" → list the 5 commands above (omit `/help`)
- "where is the config" → `~/.pi/agent/telegram.json`
- "how do I add an API key" → put it in `~/.pi/agent/telegram-agent.env` with `chmod 600`
- "how do I update the code" → `cd ~/Git/pi-telegram-agent && git pull` then restart the service
