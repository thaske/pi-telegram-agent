import { describe, expect, test } from "bun:test";

import type { TelegramApi } from "../src/telegram/api";
import { TelegramProgressManager } from "../src/telegram/progress";

async function waitFor(condition: () => boolean): Promise<void> {
  const deadline = Date.now() + 500;
  while (!condition()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for progress update");
    await Bun.sleep(5);
  }
}

function progressHarness(): {
  manager: TelegramProgressManager;
  messages: string[];
} {
  const messages: string[] = [];
  const api = {
    sendMessage: async (_chatId: number, text: string) => {
      messages.push(text);
      return { message_id: 1 };
    },
    editMessageText: async (
      _chatId: number,
      _messageId: number,
      text: string,
    ) => {
      messages.push(text);
    },
  } as unknown as TelegramApi;
  return { manager: new TelegramProgressManager(api), messages };
}

describe("Telegram progress UI", () => {
  test("hides raw commands and shows only the current action", async () => {
    const { manager, messages } = progressHarness();
    const longCommand =
      "git -C /home/wyse/Git/pi-telegram-agent status --short && find /home/wyse/Git/pi-telegram-agent/src -type f";

    manager.start(1, 10);
    manager.toolStart("bash-1", "bash", { command: longCommand });
    await waitFor(() => messages.length === 1);

    expect(messages[0]).toContain("🛠 Working");
    expect(messages[0]).toContain("Running a command");
    expect(messages[0]).not.toContain("Actions:");
    expect(messages[0]).not.toContain(longCommand);
    expect(messages[0]).not.toContain("Stop anytime");
    manager.discard();
  });

  test("does not add filler copy while thinking", async () => {
    const { manager, messages } = progressHarness();

    manager.start(1, 10);
    manager.markThinking(true);
    await waitFor(() => messages.length === 1);

    expect(messages[0]).toMatch(/^💭 Thinking · \d+s$/);
    expect(messages[0]).not.toContain("request");
    manager.discard();
  });

  test("shows a short current file without tool history", async () => {
    const { manager, messages } = progressHarness();

    manager.start(1, 10);
    manager.toolStart("bash-1", "bash", { command: "pwd" });
    await waitFor(() => messages.length === 1);
    manager.toolEnd("bash-1", "bash", {}, false);
    await waitFor(() => messages.length === 2);
    manager.toolStart("read-1", "read", {
      path: "/home/wyse/Git/pi-telegram-agent/src/telegram/progress.ts",
    });
    await waitFor(() => messages.length === 3);

    const latest = messages.at(-1) ?? "";
    expect(latest).toContain("Reading progress.ts");
    expect(latest).not.toContain("Actions:");
    expect(latest).not.toContain("/home/wyse/Git");
    expect(latest).not.toContain("earlier tool call");
    manager.discard();
  });
});
