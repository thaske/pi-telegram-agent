# Refactor plan and implementation patterns

This project should stay direct and feature-oriented, but avoid concentrating unrelated orchestration in `TelegramBridge`.

## Target boundaries

`TelegramBridge` owns only:

- Pi runtime/session binding
- Telegram polling and authorization dispatch
- high-level turn lifecycle glue
- wiring collaborators together

Move or keep moved out:

- `telegram/model-picker.ts`: model selection/search/pagination callback state
- `telegram/media-groups.ts`: Telegram media-group debounce buffering
- `pi/ui-context.ts`: no-op Telegram `uiContext` adapter for Pi extensions
- future `telegram/commands.ts`: command parsing and command handlers
- future `telegram/turn-controller.ts`: queued/active/pending turn lifecycle
- future `pi/session-event-adapter.ts`: Pi session events to Telegram preview/progress updates

## Design rules

- Prefer concrete modules over framework-style abstractions.
- Extract a responsibility when it owns state or a protocol, not just to reduce line count.
- Keep feature state close to the feature: e.g. model picker query state belongs in `ModelPicker`, not `TelegramBridge`.
- Keep `TelegramBridge` dependencies explicit through constructors and callbacks.
- Use `void promise` only for intentionally detached async work.
- Put fallback/probing state next to the API that needs it.
- Avoid generic “manager” classes unless they encapsulate a real lifecycle/state machine.

## Refactor order

1. Extract small stateful protocols from `TelegramBridge`.
   - Done: model picker.
   - Done: media group buffer.
   - Done: Pi UI context adapter.
2. Extract command routing once command behavior changes next.
3. Extract turn lifecycle only when the active/queued/pending-turn rules are documented as a state machine.
4. Extract session event adaptation after turn lifecycle is isolated.

## Lint posture

Lint should catch mechanical regressions, not act as architecture. Use warnings for size/complexity at first so refactors are guided rather than forced.
