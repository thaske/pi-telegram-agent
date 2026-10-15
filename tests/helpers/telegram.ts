import type { TelegramBridge } from "../../src/bridge";
import { TelegramApi } from "../../src/telegram/api";
import type { TelegramMessage, TelegramUpdate } from "../../src/telegram/types";

export function telegramApiHarness(options: { rich?: boolean; drafts?: boolean } = {}) {
  const calls: Array<{ method: string; body: Record<string, unknown> }> = [];
  const messages = new Map<number, string>();
  const failedSends = new Set<number>();
  let sends = 0;
  let nextId = 0;
  const api = new TelegramApi(() => ({ botToken: "offline" }), async (url, init) => {
    const method = url.split("/").at(-1)!;
    const body = JSON.parse(typeof init?.body === "string" ? init.body : "{}") as Record<string, unknown>;
    calls.push({ method, body });
    if ((!options.rich && ["sendRichMessage", "sendRichMessageDraft"].includes(method)) ||
        (!options.drafts && ["sendMessageDraft", "sendRichMessageDraft"].includes(method)))
      return Response.json({ ok: false, error_code: 404, description: "Method not found" });
    if (["sendMessage", "sendRichMessage"].includes(method)) {
      if (failedSends.has(++sends)) return Response.json({ ok: false, error_code: 503, description: "Temporary failure" });
      const rich = body.rich_message as { markdown: string } | undefined;
      messages.set(++nextId, rich?.markdown ?? String(body.text));
      return Response.json({ ok: true, result: { message_id: nextId } });
    }
    if (method === "editMessageText") {
      const rich = body.rich_message as { markdown: string } | undefined;
      messages.set(Number(body.message_id), rich?.markdown ?? String(body.text));
    }
    if (method === "deleteMessage") messages.delete(Number(body.message_id));
    return Response.json({ ok: true, result: true });
  });
  return { api, calls, messages, failedSends };
}

export function authorizedMessage(id: number, text = "request"): TelegramMessage {
  return {
    message_id: id, chat: { id: 10, type: "private" }, text,
    from: { id: 5, is_bot: false, first_name: "Test" },
  };
}

export function pollUpdates(bridge: TelegramBridge, updates: TelegramUpdate[]) {
  const controller = new AbortController();
  const call = bridge.api.call.bind(bridge.api);
  let polls = 0;
  bridge.api.call = async <T>(method: string, body: Record<string, unknown>, options?: { signal?: AbortSignal }) => {
    if (method !== "getUpdates") return call<T>(method, body, options);
    if (++polls === 1) return updates as T;
    await new Promise<void>((resolve) => {
      if (options?.signal?.aborted) resolve();
      else options?.signal?.addEventListener("abort", () => resolve(), { once: true });
    });
    return [] as T;
  };
  const polling = bridge.pollLoop(controller.signal);
  return { stop: async () => { controller.abort(); await polling; } };
}
