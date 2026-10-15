import { rejects } from "node:assert/strict";

import { expect, test } from "bun:test";

import { TelegramApi, TelegramApiError } from "../src/telegram/api";
import { telegramApiHarness } from "./helpers/telegram";

test("preserves Telegram error codes for permanent-input classification", async () => {
  const api = new TelegramApi(() => ({ botToken: "offline" }), async () =>
    Response.json({ ok: false, error_code: 400, description: "file is too big" }),
  );
  await rejects(api.call("getFile", { file_id: "big" }), (error: unknown) =>
    error instanceof TelegramApiError && error.code === 400 && error.method === "getFile" && error.permanent,
  );
});

test("physical send/edit methods never silently create multiple messages", async () => {
  const { api, messages, calls } = telegramApiHarness();
  await rejects(api.sendMessage(10, "a".repeat(5000)), RangeError);
  expect(messages.size).toBe(0);
  await api.sendMessage(10, "small");
  await rejects(api.editMessageText(10, 1, "a".repeat(5000)), RangeError);
  expect([...messages.values()]).toEqual(["small"]);
  expect(calls.filter((call) => call.method === "sendMessage")).toHaveLength(1);
});

test("ambiguous rich sends are not retried through a second representation", async () => {
  const requests: string[] = [];
  const api = new TelegramApi(() => ({ botToken: "offline" }), async (url) => {
    requests.push(url.split("/").at(-1)!);
    throw new Error("connection reset after possible acceptance");
  });
  await rejects(api.sendTextReply(10, 1, "answer"), /connection reset/);
  expect(requests).toEqual(["sendRichMessage"]);
});

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
