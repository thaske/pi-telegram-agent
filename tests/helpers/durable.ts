import { createModels } from "@earendil-works/pi-ai/models";
import { fauxProvider, type FauxResponseStep } from "@earendil-works/pi-ai/providers/faux";
import { createRegistry, defineExtension, type Extension, type HarnessSettings, type Storage } from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { CodingTools } from "@earendil-works/pi-durable/tools";

import { DurableTelegramAgent } from "../../src/pi/durable-agent";
import { createTelegramAttachTool } from "../../src/pi/telegram-attach-tool";
import type { PendingTelegramTurn } from "../../src/telegram/types";

export function agentHarness(responses: FauxResponseStep[] = [], extensions: Extension[] = [], cwd = process.cwd()) {
  const faux = fauxProvider({ models: [{ id: "test-model" }], tokensPerSecond: 100000 });
  faux.setResponses(responses);
  const models = createModels();
  models.setProvider(faux.provider);
  const registry = createRegistry();
  registry.install(CodingTools);
  registry.install(defineExtension({ name: "telegram", tools: [createTelegramAttachTool()] }));
  for (const extension of extensions) registry.install(extension);
  return {
    faux,
    registry,
    async open(storage: Storage, settings: HarnessSettings = {}) {
      return DurableTelegramAgent.open(storage, {
        models,
        registry,
        settings: { retry: { enabled: false }, compaction: { enabled: false }, ...settings },
        env: ({ cwd: directory }) => new NodeExecutionEnv({ cwd: directory ?? cwd }),
      }, {
        cwd,
        model: { provider: faux.getModel().provider, modelId: faux.getModel().id },
      });
    },
  };
}

export function pendingTurn(id = "turn-1"): PendingTelegramTurn {
  return {
    id,
    chatId: 10,
    replyToMessageId: 20,
    queuedAttachments: [],
    content: [{ type: "text", text: "request" }],
    historyText: "request",
  };
}

export async function waitUntil(check: () => boolean | Promise<boolean>, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!await check()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for condition");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
