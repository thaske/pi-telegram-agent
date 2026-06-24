import {
  TELEGRAM_PROGRESS_INITIAL_DELAY_MS,
  TELEGRAM_PROGRESS_THROTTLE_MS,
} from "../constants.js";
import { log } from "../logger.js";
import type { TelegramInlineKeyboardMarkup } from "./types.js";
import { TelegramApi } from "./api.js";

type ToolState = "running" | "done" | "error";

interface ProgressTool {
  id: string;
  name: string;
  label: string;
  state: ToolState;
  startedAt: number;
  endedAt?: number;
  note?: string;
}

interface ProgressState {
  chatId: number;
  replyToMessageId: number;
  startedAt: number;
  messageId?: number;
  visible: boolean;
  completed: boolean;
  failed?: string;
  thinkingActive: boolean;
  thinkingSeen: boolean;
  assistantStreaming: boolean;
  workingMessage?: string;
  hiddenThinkingLabel?: string;
  statuses: Map<string, string>;
  tools: ProgressTool[];
  lastSentText: string;
  flushTimer?: ReturnType<typeof setTimeout>;
  initialTimer?: ReturnType<typeof setTimeout>;
  flushInFlight?: boolean;
  queuedFlush?: boolean;
}

export class TelegramProgressManager {
  private state: ProgressState | undefined;

  constructor(private readonly api: TelegramApi) {}

  start(chatId: number, replyToMessageId: number): void {
    this.discard();
    const state: ProgressState = {
      chatId,
      replyToMessageId,
      startedAt: Date.now(),
      visible: false,
      completed: false,
      thinkingActive: false,
      thinkingSeen: false,
      assistantStreaming: false,
      statuses: new Map(),
      tools: [],
      lastSentText: "",
    };
    state.initialTimer = setTimeout(
      () => void this.flush(true),
      TELEGRAM_PROGRESS_INITIAL_DELAY_MS,
    );
    this.state = state;
  }

  discard(): void {
    const state = this.state;
    if (state?.flushTimer) clearTimeout(state.flushTimer);
    if (state?.initialTimer) clearTimeout(state.initialTimer);
    this.state = undefined;
  }

  hasVisibleProgress(): boolean {
    return !!this.state?.visible;
  }

  setWorkingMessage(message?: string): void {
    const state = this.state;
    if (!state) return;
    state.workingMessage = message;
    this.scheduleFlush();
  }

  setStatus(key: string, text: string | undefined): void {
    const state = this.state;
    if (!state) return;
    if (text) state.statuses.set(key, text);
    else state.statuses.delete(key);
    this.scheduleFlush();
  }

  setHiddenThinkingLabel(label?: string): void {
    const state = this.state;
    if (!state) return;
    state.hiddenThinkingLabel = label;
    this.scheduleFlush();
  }

  markThinking(active: boolean): void {
    const state = this.state;
    if (!state) return;
    state.thinkingActive = active;
    state.thinkingSeen = state.thinkingSeen || active;
    this.scheduleFlush(active);
  }

  markAssistantStreaming(): void {
    const state = this.state;
    if (!state) return;
    state.assistantStreaming = true;
    this.scheduleFlush();
  }

  toolStart(toolCallId: string, toolName: string, args: unknown): void {
    const state = this.state;
    if (!state) return;
    const existing = state.tools.find((tool) => tool.id === toolCallId);
    const label = this.formatToolLabel(toolName, args);
    if (existing) {
      existing.name = toolName;
      existing.label = label;
      existing.state = "running";
      existing.note = undefined;
    } else {
      state.tools.push({
        id: toolCallId,
        name: toolName,
        label,
        state: "running",
        startedAt: Date.now(),
      });
    }
    this.scheduleFlush(true);
  }

  toolUpdate(toolCallId: string, toolName: string, args: unknown): void {
    const state = this.state;
    if (!state) return;
    const tool = state.tools.find((candidate) => candidate.id === toolCallId);
    if (tool) {
      tool.name = toolName;
      tool.label = this.formatToolLabel(toolName, args);
      tool.state = "running";
    } else {
      state.tools.push({
        id: toolCallId,
        name: toolName,
        label: this.formatToolLabel(toolName, args),
        state: "running",
        startedAt: Date.now(),
      });
    }
    this.scheduleFlush();
  }

  toolEnd(
    toolCallId: string,
    toolName: string,
    result: unknown,
    isError: boolean,
  ): void {
    const state = this.state;
    if (!state) return;
    const tool = state.tools.find((candidate) => candidate.id === toolCallId);
    const note = isError ? this.summarizeToolError(result) : undefined;
    if (tool) {
      tool.state = isError ? "error" : "done";
      tool.endedAt = Date.now();
      tool.note = note;
    } else {
      state.tools.push({
        id: toolCallId,
        name: toolName,
        label: toolName,
        state: isError ? "error" : "done",
        startedAt: Date.now(),
        endedAt: Date.now(),
        note,
      });
    }
    this.scheduleFlush(true);
  }

  complete(): void {
    const state = this.state;
    if (!state) return;
    state.completed = true;
    state.thinkingActive = false;
    state.assistantStreaming = false;
    if (state.initialTimer) clearTimeout(state.initialTimer);
    state.initialTimer = undefined;
    if (!state.visible) {
      this.discard();
      return;
    }
    this.scheduleFlush(true);
  }

  fail(message: string): void {
    const state = this.state;
    if (!state) return;
    state.completed = true;
    state.failed = message;
    state.thinkingActive = false;
    state.assistantStreaming = false;
    if (state.initialTimer) clearTimeout(state.initialTimer);
    state.initialTimer = undefined;
    this.scheduleFlush(true);
  }

  private scheduleFlush(forceVisible = false): void {
    const state = this.state;
    if (!state) return;
    if (forceVisible) {
      if (state.initialTimer) clearTimeout(state.initialTimer);
      state.initialTimer = undefined;
      void this.flush(true);
      return;
    }
    if (!state.visible) return;
    if (state.flushTimer) return;
    state.flushTimer = setTimeout(
      () => void this.flush(false),
      TELEGRAM_PROGRESS_THROTTLE_MS,
    );
  }

  private async flush(forceVisible: boolean): Promise<void> {
    const state = this.state;
    if (!state) return;
    if (state.flushInFlight) {
      state.queuedFlush = true;
      return;
    }
    if (state.flushTimer) {
      clearTimeout(state.flushTimer);
      state.flushTimer = undefined;
    }
    if (state.initialTimer) {
      clearTimeout(state.initialTimer);
      state.initialTimer = undefined;
    }
    if (!forceVisible && !state.visible) return;

    state.flushInFlight = true;
    try {
      const text = this.render(state);
      if (!text.trim() || text === state.lastSentText) return;
      const replyMarkup = state.completed ? undefined : this.stopMarkup();
      if (!state.visible || state.messageId === undefined) {
        const sent = await this.api.sendMessage(state.chatId, text, replyMarkup);
        state.messageId = sent.message_id;
        state.visible = true;
      } else {
        await this.api.editMessageText(
          state.chatId,
          state.messageId,
          text,
          replyMarkup,
        );
      }
      state.lastSentText = text;
    } catch (error) {
      log(
        `progress update failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      state.flushInFlight = false;
      if (state.queuedFlush) {
        state.queuedFlush = false;
        this.scheduleFlush();
      }
    }
  }

  private render(state: ProgressState): string {
    const elapsed = this.formatElapsed(Date.now() - state.startedAt);
    const runningTools = state.tools.filter((tool) => tool.state === "running");
    const failedTools = state.tools.filter((tool) => tool.state === "error");
    const completedTools = state.tools.filter((tool) => tool.state === "done");
    const toolCount = state.tools.length;
    const status = state.failed
      ? "❌ Error"
      : state.completed
        ? "✅ Done"
        : runningTools.length
          ? "🛠 Using tools"
          : state.thinkingActive
            ? "💭 Thinking"
            : state.assistantStreaming
              ? "✍️ Writing"
              : "🔄 Working";

    const lines: string[] = [`${status}  ·  ${elapsed}`];
    if (!state.completed) lines.push("Stop anytime: /stop");

    const current = state.workingMessage ?? this.currentActivity(state);
    if (current) {
      lines.push("", "▸ Current", this.indent(this.truncate(current, 180)));
    }

    if (toolCount) {
      const failed = failedTools.length ? ` · ${failedTools.length} failed` : "";
      lines.push(
        "",
        `▸ Tools  ${completedTools.length}/${toolCount} done${failed}`,
      );
      const visibleTools = state.tools.slice(-5);
      const hidden = state.tools.length - visibleTools.length;
      if (hidden > 0)
        lines.push(this.indent(`… ${hidden} earlier tool call${hidden === 1 ? "" : "s"}`));
      for (const tool of visibleTools) lines.push(...this.renderTool(tool));
    } else if (state.thinkingSeen) {
      lines.push(
        "",
        "▸ Thinking",
        this.indent(
          state.hiddenThinkingLabel ??
            "Reasoning privately — raw chain-of-thought is hidden.",
        ),
      );
    }

    const visibleStatuses = [...state.statuses.entries()].slice(-2);
    if (visibleStatuses.length) {
      lines.push("", "▸ Notes");
      for (const [key, value] of visibleStatuses)
        lines.push(this.indent(this.truncate(`${key}: ${value}`, 140)));
    }

    if (state.failed)
      lines.push("", "▸ Error", this.indent(this.truncate(state.failed, 500)));
    return lines.join("\n");
  }

  private currentActivity(state: ProgressState): string | undefined {
    const running = state.tools.filter((tool) => tool.state === "running").at(-1);
    if (running) return `Using ${running.label}`;
    if (state.thinkingActive)
      return state.hiddenThinkingLabel ?? "Reasoning privately — raw chain-of-thought is hidden.";
    if (state.assistantStreaming) return "Writing response text";
    return undefined;
  }

  private renderTool(tool: ProgressTool): string[] {
    const icon = tool.state === "running" ? "⏳" : tool.state === "done" ? "✅" : "❌";
    const duration = tool.endedAt
      ? ` · ${this.formatElapsed(tool.endedAt - tool.startedAt)}`
      : "";
    const [name, detail] = this.splitToolLabel(tool.label);
    const lines = [this.indent(`${icon} ${this.truncate(name, 72)}${duration}`)];
    if (detail) lines.push(this.indent(this.truncate(detail, 120), 2));
    if (tool.note) lines.push(this.indent(this.truncate(tool.note, 120), 2));
    return lines;
  }

  private indent(text: string, level = 1): string {
    return `${"  ".repeat(level)}${text}`;
  }

  private splitToolLabel(label: string): [string, string | undefined] {
    const index = label.indexOf(": ");
    if (index === -1) return [label, undefined];
    return [label.slice(0, index), label.slice(index + 2)];
  }

  private stopMarkup(): TelegramInlineKeyboardMarkup {
    return { inline_keyboard: [[{ text: "Stop", callback_data: "turn:stop" }]] };
  }

  private formatToolLabel(toolName: string, args: unknown): string {
    const data = this.asRecord(args);
    const name = toolName || "tool";
    const path = this.stringValue(data, "path");
    const command = this.stringValue(data, "command");
    const query = this.stringValue(data, "query");
    const topic = this.stringValue(data, "topic");
    const url = this.firstString(data?.urls) ?? this.stringValue(data, "url");

    if (command) return `${name}: ${this.singleLine(command)}`;
    if (path) return `${name}: ${path}`;
    if (query) return `${name}: ${this.singleLine(query)}`;
    if (topic) return `${name}: ${this.singleLine(topic)}`;
    if (url) return `${name}: ${this.singleLine(url)}`;

    const summary = this.summarizeArgs(data);
    return summary ? `${name}: ${summary}` : name;
  }

  private summarizeArgs(data: Record<string, unknown> | undefined): string {
    if (!data) return "";
    const entries = Object.entries(data)
      .filter(([, value]) => ["string", "number", "boolean"].includes(typeof value))
      .slice(0, 2)
      .map(([key, value]) => `${key}=${this.singleLine(String(value))}`);
    return this.truncate(entries.join(", "), 120);
  }

  private summarizeToolError(result: unknown): string | undefined {
    const data = this.asRecord(result);
    const content = data?.content;
    if (Array.isArray(content)) {
      const text = content
        .map((item) => this.asRecord(item)?.text)
        .filter((value): value is string => typeof value === "string")
        .join(" ")
        .trim();
      if (text) return this.singleLine(text);
    }
    if (typeof data?.error === "string") return this.singleLine(data.error);
    if (typeof data?.message === "string") return this.singleLine(data.message);
    return undefined;
  }

  private asRecord(value: unknown): Record<string, unknown> | undefined {
    return typeof value === "object" && value !== null
      ? (value as Record<string, unknown>)
      : undefined;
  }

  private stringValue(
    data: Record<string, unknown> | undefined,
    key: string,
  ): string | undefined {
    const value = data?.[key];
    return typeof value === "string" && value.trim() ? value.trim() : undefined;
  }

  private firstString(value: unknown): string | undefined {
    if (!Array.isArray(value)) return undefined;
    const first = value.find((item) => typeof item === "string" && item.trim());
    return typeof first === "string" ? first.trim() : undefined;
  }

  private singleLine(value: string): string {
    return value.replace(/\s+/g, " ").trim();
  }

  private truncate(value: string, max: number): string {
    return value.length <= max ? value : `${value.slice(0, Math.max(0, max - 1))}…`;
  }

  private formatElapsed(ms: number): string {
    const totalSeconds = Math.max(0, Math.round(ms / 1000));
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    if (minutes === 0) return `${seconds}s`;
    return `${minutes}m ${seconds.toString().padStart(2, "0")}s`;
  }
}
