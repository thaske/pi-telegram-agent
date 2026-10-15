---
name: pi-telegram-agent
description: Operate and troubleshoot the pi-telegram-agent Telegram bot, its durable storage, configuration, and systemd service.
---

# pi-telegram-agent

This skill provides operational knowledge about the **pi-telegram-agent** project: a standalone Telegram frontend for Pi powered by `@earendil-works/pi-durable`.

The repo lives at `~/Git/pi-telegram-agent`. The agent runs as a **systemd user service** (`pi-telegram-agent.service`).

## Architecture

- `systemd --user` → `bun run src/main.ts` → `pi-durable Harness` → SQLite.
- Polls Telegram directly via `getUpdates`; persists admitted turns and buffered albums before advancing the polling offset.
- Reuses Pi config from `~/.pi/agent/` (`settings.json`, `auth.json`, `models.json`, skills, context files, and system-prompt files).
- Runs native durable coding tools plus `telegram_attach`. SDK extensions and their custom commands/tools are not loaded.
- Config file is `~/.pi/agent/telegram.json`.
- Optional env vars:
  - `PI_TELEGRAM_CONFIG` (defaults to `~/.pi/agent/telegram.json`)
  - `PI_TELEGRAM_TMP` (defaults to `~/.pi/agent/tmp/telegram-agent`)
  - `PI_TELEGRAM_CWD` (defaults to process start directory; often set to `%h` = `$HOME` in systemd)
  - `PI_TELEGRAM_STORAGE` (defaults to `<agent-dir>/telegram-agent/<cwd-hash>/state.sqlite`)
  - `PI_CODING_AGENT_DIR` (overrides `~/.pi/agent` for Pi resources and the default storage location)
  - `EXA_API_KEY` (loaded via `EnvironmentFile=-%h/.pi/agent/telegram-agent.env` in systemd)

## Startup Behavior

On startup, the bot reopens its durable SQLite storage and restores the selected conversation, queued turns, buffered albums, and pending response deliveries. Interrupted model/tool work resumes from its committed checkpoint using idempotent submission IDs; it is not re-prompted as a new input. Only replay-safe interrupted tools rerun.

A legacy `pending-turn.json` in `TEMP_DIR` is imported once before its file is removed. Old SDK JSONL sessions are left untouched, not automatically imported. A completed legacy response only retries delivery; unfinished legacy work starts in the new durable conversation.

`/new` selects a fresh persisted conversation. `/stop` aborts the current run without discarding the Telegram queue. Service shutdown suspends work rather than aborting it.

Keep the SQLite file (and its WAL files) outside temporary cleanup paths, and run only one bot process per database. Input receipts are per Telegram message, including album members. `/new` and `/compact` retain durable command identities; compaction runs outside polling and can be stopped. Reply delivery tracks each physical text chunk/file, and legacy preview IDs survive restart for cleanup. Telegram delivery is still at-least-once across a crash between a successful send and its receipt commit.

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
| `src/pi/durable-agent.ts`                     | Native harness, submissions, conversation lifecycle |
| `src/pi/durable-state.ts`                     | Durable queue, buffered albums, delivery receipts   |
| `src/pi/config.ts`                            | Pi configuration and durable extension registry     |
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
