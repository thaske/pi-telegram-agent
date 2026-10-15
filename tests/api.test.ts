import { expect, test } from "bun:test";

import { TelegramApi } from "../src/telegram/api";

test("publishes the supported Telegram command suggestions", async () => {
  const api = new TelegramApi(() => ({ botToken: "test-token" }));
  let commands: Array<{ command: string; description: string }> | undefined;
  api.call = async <TResponse>(
    method: string,
    body: Record<string, unknown>,
  ) => {
    expect(method).toBe("setMyCommands");
    commands = body.commands as Array<{ command: string; description: string }>;
    return true as TResponse;
  };

  await api.configureCommands();

  expect(commands?.map((command) => command.command)).toEqual([
    "new", "status", "model", "compact", "stop",
  ]);
});
