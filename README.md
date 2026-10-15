# pi-telegram-agent

Standalone Telegram frontend for Pi using `@earendil-works/pi-durable`.

```text
systemd → bun run src/main.ts → pi-durable Harness → SQLite
```

## Features

- Reuses Pi's configuration services for `settings.json`, `auth.json`, `models.json`, skills, context files, and `SYSTEM.md` / `APPEND_SYSTEM.md`.
- Runs native durable `read`, `bash`, `edit`, and `write` tools in `PI_TELEGRAM_CWD`.
- Persists conversations, model/tool checkpoints, the Telegram queue, buffered albums, attachment intents, and reply-delivery receipts in SQLite.
- Resumes interrupted runs from their last committed checkpoint. Per-message receipts prevent redelivery—including partial albums—from submitting the same input twice. New late album members are admitted separately without replaying earlier members.
- Durably rejects permanently unavailable Telegram files without blocking subsequent messages. Transient preparation failures remain retryable.
- Polls Telegram directly.
- Registers Telegram bot command suggestions:
  - `/new`
  - `/status`
  - `/compact`
  - `/model`
  - `/stop`
- Reopens the selected durable conversation after a restart.
- `/new` creates and durably selects a fresh conversation, preserving the current model and keeping older conversations in storage. Its request receipt commits with the selection, so a failed notification cannot create another conversation on retry.
- `/compact` runs outside the polling handler, remains stoppable with `/stop`, and resumes its original task after restart. Completion notices use the durable reply queue.
- `/model` opens a Telegram inline keyboard to select or search any authenticated Pi model, sorted by OpenRouter weekly popularity when available.
- Streams temporary assistant previews back to Telegram, using Bot API 10.1 rich message drafts when available. Legacy previews stay within one message; their IDs are persisted for cleanup after restart. Only the durable outbox sends final answers.
- Shows a throttled in-chat progress panel for long turns, including safe thinking status, tool-call lifecycle summaries, retries/compaction, elapsed time, and a Stop button.
- Sends assistant output as Bot API 10.1 rich Markdown messages when available (headings, lists, tables, media blocks, quotes, footnotes, formulas, and nested formatting), with automatic fallback to legacy Telegram HTML formatting.
- Supports Telegram image/file downloads.
- Provides a `telegram_attach` tool so Pi can send generated files back to Telegram.

## Migration from the SDK runtime

The bot now uses native `pi-durable` conversations and tasks, not `AgentSessionRuntime`. `pi-coding-agent` remains a dependency **only for configuration/resource/model-auth services**.

- The first durable startup begins a new conversation. Existing Pi SDK JSONL sessions are left untouched and are not automatically imported.
- An existing `pending-turn.json` is imported before its legacy journal is removed. A completed reply retries delivery only; an unfinished legacy turn is submitted once to the new conversation.
- SDK extensions, their custom tools/commands, and MCP integrations are not loaded: their APIs are not compatible with durable extensions. The old goal command integration has been removed.
- The supported Telegram commands are `/new`, `/status`, `/model`, `/compact`, and `/stop`. SDK prompt-template and skill slash commands are not interpreted. Skills remain discoverable and readable by the model.
- Project resources follow saved Pi trust decisions (`trust.json`), falling back to the global `defaultProjectTrust` setting. In this headless process, `ask` means project resources are skipped until trusted.
- Model defaults/thinking, retry/transport settings, compaction thresholds, shell path, and the durable subset of `defaultTools` are reused. Extension-specific and terminal settings do not apply.

Durable tools follow their own replay policies: completed calls are not repeated; interrupted calls only rerun when declared replay-safe. `/stop` aborts the current run; shutting down suspends it for the next process. Queued Telegram turns remain queued.

Telegram sends cannot be part of a SQLite transaction. The reply outbox freezes a physical message plan and commits a receipt after each acknowledged chunk/file; ordinary retries do not resend a successful prefix. A crash after Telegram accepts a send and before its receipt commits can still duplicate that send. Ambiguous transport failures are retried by the outbox, not immediately resent using a different format.

The state additions are backward-compatible with existing databases and pending journals. On first open, individual input receipts are recovered from retained pending/completed Telegram turn IDs. Receipts older than the previous version's retained history cannot be reconstructed.

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
PI_TELEGRAM_STORAGE=/path/to/state.sqlite
EXA_API_KEY=...
```

`PI_TELEGRAM_TMP` controls where files downloaded from Telegram are stored before being passed to Pi. If unset, it defaults to `~/.pi/agent/tmp/telegram-agent`.

`PI_TELEGRAM_CWD` controls the working directory for the Pi agent session, including where commands run and how relative paths are resolved. If unset, it defaults to the directory where this process is started.

`PI_TELEGRAM_STORAGE` overrides the SQLite file. By default it is `<agent-dir>/telegram-agent/<cwd-hash>/state.sqlite`, where `<agent-dir>` is normally `~/.pi/agent` (or `PI_CODING_AGENT_DIR`). Keep it outside temporary download directories and run **only one process per database**. The storage does not provide cross-process locking.

## Checks

```bash
bun run typecheck
bun test
bun run lint
```

Tests use an offline faux model, including SQLite reopen, tool replay, attachment idempotency, queued delivery, and Telegram redelivery. The SQLite adapter uses `node:sqlite`; Bun 1.4.2 is tested.

## Example systemd user service

```ini
[Unit]
Description=Pi Telegram durable agent
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
