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
      "git -C /home/user/Git/pi-telegram-agent status --short && find /home/user/Git/pi-telegram-agent/src -type f";

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
      path: "/home/user/Git/pi-telegram-agent/src/telegram/progress.ts",
    });
    await waitFor(() => messages.length === 3);

    const latest = messages.at(-1) ?? "";
    expect(latest).toContain("Reading progress.ts");
    expect(latest).not.toContain("Actions:");
    expect(latest).not.toContain("/home/user/Git");
    expect(latest).not.toContain("earlier tool call");
    manager.discard();
  });

  test("takes down a panel discarded while its first send was in flight", async () => {
    const deleted: number[] = [];
    let releaseSend: ((sent: { message_id: number }) => void) | undefined;
    const api = {
      sendMessage: () =>
        new Promise<{ message_id: number }>((resolve) => {
          releaseSend = resolve;
        }),
      editMessageText: async () => undefined,
      deleteMessage: async (_chatId: number, messageId: number) => {
        deleted.push(messageId);
      },
    } as unknown as TelegramApi;
    const manager = new TelegramProgressManager(api);

    manager.start(1, 10);
    manager.toolStart("bash-1", "bash", { command: "pwd" });
    // The turn finishes before Telegram acknowledges the panel.
    manager.complete();
    releaseSend?.({ message_id: 77 });
    await waitFor(() => deleted.length === 1);

    expect(deleted).toEqual([77]);
    expect(manager.hasVisibleProgress()).toBe(false);
  });

  test("still renders the final update when it is coalesced mid-send", async () => {
    const messages: string[] = [];
    let releaseSend: ((sent: { message_id: number }) => void) | undefined;
    const api = {
      sendMessage: (_chatId: number, text: string) =>
        new Promise<{ message_id: number }>((resolve) => {
          messages.push(text);
          releaseSend = resolve;
        }),
      editMessageText: async (_chatId: number, _messageId: number, text: string) => {
        messages.push(text);
      },
      deleteMessage: async () => undefined,
    } as unknown as TelegramApi;
    const manager = new TelegramProgressManager(api);

    manager.start(1, 10);
    manager.toolStart("bash-1", "bash", { command: "pwd" });
    await waitFor(() => messages.length === 1);
    manager.fail("boom");
    releaseSend?.({ message_id: 42 });
    await waitFor(() => messages.length === 2);

    expect(messages.at(-1)).toContain("❌ Error");
    expect(messages.at(-1)).toContain("boom");
    manager.discard();
  });
});
