import { basename } from "node:path";

import {
  TELEGRAM_PROGRESS_INITIAL_DELAY_MS,
  TELEGRAM_PROGRESS_THROTTLE_MS,
} from "../constants";
import { log } from "../logger";
import { TelegramApi } from "./api";
import type { TelegramInlineKeyboardMarkup } from "./types";

type ToolState = "running" | "done" | "error";

const FILE_TOOL_VERBS: Record<string, string> = {
  read: "Reading",
  edit: "Updating",
  write: "Writing",
};

const SIMPLE_TOOL_ACTIVITIES: Record<string, string> = {
  bash: "Running a command",
  memory: "Saving context",
  skill_manage: "Updating a workflow",
  telegram_attach: "Preparing an attachment",
  mcp: "Using the browser",
};

const CONTEXT_TOOLS = new Set(["memory_search", "session_search"]);
const WEB_TOOL_ACTIVITIES: Record<string, string> = {
  web_search_exa: "Searching the web",
  web_answer_exa: "Researching an answer",
  web_find_similar_exa: "Finding related sources",
};
const RESEARCH_TOOL_ACTIVITIES: Record<string, string> = {
  exa_research_step: "Planning research",
  exa_research_status: "Reviewing research progress",
  exa_research_summary: "Summarizing the research plan",
  exa_research_reset: "Resetting the research plan",
};

interface ToolPresentation {
  activity: string;
  detail?: string;
}

interface ProgressTool extends ToolPresentation {
  id: string;
  state: ToolState;
  startedAt: number;
  endedAt?: number;
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
    const presentation = this.formatToolPresentation(toolName, args);
    if (existing) {
      Object.assign(existing, presentation, { state: "running" as const });
    } else {
      state.tools.push({
        id: toolCallId,
        ...presentation,
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
    const presentation = this.formatToolPresentation(toolName, args);
    if (tool) {
      Object.assign(tool, presentation, { state: "running" as const });
    } else {
      state.tools.push({
        id: toolCallId,
        ...presentation,
        state: "running",
        startedAt: Date.now(),
      });
    }
    this.scheduleFlush();
  }

  toolEnd(
    toolCallId: string,
    toolName: string,
    _result: unknown,
    isError: boolean,
  ): void {
    const state = this.state;
    if (!state) return;
    const tool = state.tools.find((candidate) => candidate.id === toolCallId);
    if (tool) {
      tool.state = isError ? "error" : "done";
      tool.endedAt = Date.now();
    } else {
      state.tools.push({
        id: toolCallId,
        ...this.formatToolPresentation(toolName, undefined),
        state: isError ? "error" : "done",
        startedAt: Date.now(),
        endedAt: Date.now(),
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
        const sent = await this.api.sendMessage(
          state.chatId,
          text,
          replyMarkup,
        );
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
    const paragraphs = [`${this.statusLabel(state)} · ${elapsed}`];

    if (!state.completed && !state.failed) {
      const activity = state.workingMessage ?? this.currentActivity(state);
      if (activity)
        paragraphs.push(this.truncate(this.singleLine(activity), 84));
    }
    if (state.failed)
      paragraphs.push(this.truncate(this.singleLine(state.failed), 240));

    return paragraphs.join("\n\n");
  }

  private statusLabel(state: ProgressState): string {
    if (state.failed) return "❌ Error";
    if (state.completed) return "✅ Done";
    if (state.tools.some((tool) => tool.state === "running")) {
      return "🛠 Working";
    }
    if (state.thinkingActive) return "💭 Thinking";
    if (state.assistantStreaming) return "✍️ Writing";
    return "🔄 Starting";
  }

  private currentActivity(state: ProgressState): string | undefined {
    const running = state.tools
      .filter((tool) => tool.state === "running")
      .at(-1);
    if (running) return this.toolActivity(running);

    const status = [...state.statuses.values()].at(-1);
    if (status) return status;
    if (state.thinkingActive) return state.hiddenThinkingLabel;
    return undefined;
  }

  private toolActivity(tool: ProgressTool): string {
    return tool.detail ? `${tool.activity} · ${tool.detail}` : tool.activity;
  }

  private stopMarkup(): TelegramInlineKeyboardMarkup {
    return {
      inline_keyboard: [[{ text: "Stop", callback_data: "turn:stop" }]],
    };
  }

  private formatToolPresentation(
    toolName: string,
    args: unknown,
  ): ToolPresentation {
    const data = this.asRecord(args);
    const normalized = toolName.toLowerCase();
    const shortName = normalized.split(/[.:/]/).at(-1) || "tool";
    const file = this.fileDetail(this.stringValue(data, "path"));

    if (this.isParallelTool(normalized, shortName)) {
      const count = Array.isArray(data?.tool_uses) ? data.tool_uses.length : 0;
      return {
        activity: count
          ? `Running ${count} tasks in parallel`
          : "Running tasks in parallel",
      };
    }

    const fileVerb = FILE_TOOL_VERBS[shortName];
    if (fileVerb)
      return { activity: file ? `${fileVerb} ${file}` : `${fileVerb} a file` };
    if (CONTEXT_TOOLS.has(shortName))
      return { activity: "Reviewing prior context" };

    const webActivity = WEB_TOOL_ACTIVITIES[shortName];
    if (webActivity)
      return this.withDetail(webActivity, this.searchDetail(data));
    if (shortName === "web_fetch_exa")
      return this.withDetail(
        "Reading web sources",
        this.urlHost(this.sourceUrl(data)),
      );
    const researchActivity = RESEARCH_TOOL_ACTIVITIES[shortName];
    if (researchActivity) return { activity: researchActivity };

    const simpleActivity = SIMPLE_TOOL_ACTIVITIES[shortName];
    return simpleActivity
      ? { activity: simpleActivity }
      : { activity: `Using ${this.humanizeToolName(shortName)}` };
  }

  private isParallelTool(normalized: string, shortName: string): boolean {
    return normalized === "multi_tool_use.parallel" || shortName === "parallel";
  }

  private searchDetail(
    data: Record<string, unknown> | undefined,
  ): string | undefined {
    return this.stringValue(data, "query") ?? this.stringValue(data, "topic");
  }

  private sourceUrl(
    data: Record<string, unknown> | undefined,
  ): string | undefined {
    return this.firstString(data?.urls) ?? this.stringValue(data, "url");
  }

  private withDetail(activity: string, detail?: string): ToolPresentation {
    return detail
      ? { activity, detail: this.truncate(this.singleLine(detail), 48) }
      : { activity };
  }

  private fileDetail(path?: string): string | undefined {
    if (!path) return undefined;
    return this.truncate(basename(path) || path, 48);
  }

  private urlHost(url?: string): string | undefined {
    if (!url) return undefined;
    try {
      return new URL(url).hostname.replace(/^www\./, "");
    } catch {
      return undefined;
    }
  }

  private humanizeToolName(name: string): string {
    return name.replace(/[_-]+/g, " ").trim() || "a tool";
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
    const first = (value as unknown[]).find(
      (item) => typeof item === "string" && item.trim(),
    );
    return typeof first === "string" ? first.trim() : undefined;
  }

  private singleLine(value: string): string {
    return value.replace(/\s+/g, " ").trim();
  }

  private truncate(value: string, max: number): string {
    return value.length <= max
      ? value
      : `${value.slice(0, Math.max(0, max - 1))}…`;
  }

  private formatElapsed(ms: number): string {
    const totalSeconds = Math.max(0, Math.round(ms / 1000));
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    if (minutes === 0) return `${seconds}s`;
    return `${minutes}m ${seconds.toString().padStart(2, "0")}s`;
  }
}
