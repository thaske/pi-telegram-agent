import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Model, Models } from "@earendil-works/pi-ai";
import {
  AssistantEntry,
  CompactionTask,
  configure,
  Harness,
  LiveDoc,
  watchEvents,
  type AgentChange,
  type AgentEvent,
  type AgentEventStream,
  type Conversation,
  type CompactionResult,
  type TaskId,
  type HarnessOptions,
  type Storage,
} from "@earendil-works/pi-durable";

import type { PendingTelegramTurn, QueuedAttachment, TelegramMessage } from "../telegram/types";
import { DurableTelegramState, initializeReceipts, TelegramState, toJson } from "./durable-state";
import { getMessageText } from "./session-messages";

export interface TelegramAgentStatus {
  totalMessages: number;
  cost: number;
  contextTokens?: number;
  contextWindow?: number;
}

export interface TelegramTurnResult {
  text?: string;
  error?: string;
  aborted?: boolean;
  queuedAttachments: QueuedAttachment[];
}

function unansweredResult(reason: string, detail: unknown): TelegramTurnResult {
  return reason === "aborted"
    ? { aborted: true, queuedAttachments: [] }
    : { error: typeof detail === "string" ? detail : `Pi could not answer: ${reason}`, queuedAttachments: [] };
}

export class DurableTelegramAgent {
  readonly state: DurableTelegramState;
  private conversation!: Conversation;
  private view!: Awaited<ReturnType<Conversation["viewState"]>>;
  private events: AgentEventStream | undefined;
  private readonly listeners = new Set<(event: AgentEvent) => void>();
  private activeOperation = false;
  private runningTurnId: string | undefined;
  private abortRequestedTurnId: string | undefined;
  private currentModel: Model<string> | undefined;

  private constructor(
    readonly harness: Harness,
    readonly models: Models,
    private readonly initialAgent: AgentChange,
  ) {
    this.state = new DurableTelegramState(harness);
  }

  static async open(
    storage: Storage,
    options: HarnessOptions,
    initialAgent: AgentChange,
  ): Promise<DurableTelegramAgent> {
    const harness = await Harness.open(storage, options, BACKGROUND_CONTEXT);
    try {
      const agent = new DurableTelegramAgent(harness, options.models, initialAgent);
      const root = await harness.root(BACKGROUND_CONTEXT, { agent: initialAgent });
      const state = await harness.snapshot(TelegramState, BACKGROUND_CONTEXT);
      const conversation = state?.conversationId === undefined
        ? root
        : await harness.conversation(state.conversationId, BACKGROUND_CONTEXT);
      if (!conversation) throw new Error(`Missing durable conversation ${state?.conversationId}`);
      await harness.commit(async (tx) => {
        const telegram = await tx.doc(TelegramState);
        telegram.conversationId = conversation.id;
        initializeReceipts(telegram);
      }, BACKGROUND_CONTEXT);
      await agent.bind(conversation);
      return agent;
    } catch (error) {
      await harness.close(BACKGROUND_CONTEXT);
      throw error;
    }
  }

  get conversationId() {
    return this.conversation.id;
  }

  get model(): Model<string> | undefined {
    return this.currentModel;
  }

  get isStreaming(): boolean {
    const live = this.view.value.docs["pi.live"];
    return this.activeOperation || !!live?.run || !!(live?.compactions as unknown[] | undefined)?.length;
  }

  subscribe(listener: (event: AgentEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async enqueueTurn(turn: PendingTelegramTurn, mediaMessages: TelegramMessage[] = []): Promise<boolean> {
    turn.conversationId ??= this.conversationId;
    return this.state.enqueue(turn, mediaMessages);
  }

  async runTurn(turn: PendingTelegramTurn): Promise<TelegramTurnResult> {
    if (turn.conversationId !== this.conversationId)
      throw new Error(`Telegram turn ${turn.id} belongs to another conversation`);
    if (this.activeOperation) throw new Error("Another agent operation is already running");
    this.activeOperation = true;
    let events: AgentEventStream | undefined;
    this.runningTurnId = turn.id;
    try {
      if (await this.state.wasStopped(turn.id)) {
        await this.conversation.abort(BACKGROUND_CONTEXT);
        return { aborted: true, queuedAttachments: [] };
      }
      events = await watchEvents(this.harness, this.conversationId, BACKGROUND_CONTEXT);
      this.events = events;
      this.publish(events.snapshot);
      events.start(async (batch) => {
        for (const event of batch) this.publish(event);
      });
      const submission = await this.conversation.submit({
        type: "input",
        content: turn.content,
        requestId: turn.id,
      }, BACKGROUND_CONTEXT);
      if (this.abortRequestedTurnId === turn.id) await this.conversation.abort(BACKGROUND_CONTEXT);
      const settled = await submission.wait(BACKGROUND_CONTEXT);
      if (settled.status === "unanswered") return unansweredResult(settled.reason, settled.detail);
      if (settled.type !== "input") throw new Error("Expected an input submission");
      const answer = await this.conversation.commit((tx) => tx.entry(AssistantEntry, settled.answer), BACKGROUND_CONTEXT);
      const message = answer?.model?.find((item) => item.role === "assistant");
      const saved = (await this.state.pendingTurns()).find((pending) => pending.id === turn.id);
      return { text: message ? getMessageText(message) : undefined, queuedAttachments: saved?.queuedAttachments ?? [] };
    } finally {
      this.activeOperation = false;
      this.runningTurnId = undefined;
      if (this.abortRequestedTurnId === turn.id) this.abortRequestedTurnId = undefined;
      if (this.events === events) this.events = undefined;
      await events?.stop();
    }
  }

  async newSession(requestId?: string): Promise<void> {
    if (requestId && await this.state.command(requestId)) return;
    if (this.isStreaming || (await this.state.pendingTurns()).length || (await this.state.bufferedMedia()).length)
      throw new Error("Cannot start a new chat while Telegram work is pending");
    const current = await this.conversation.agent(BACKGROUND_CONTEXT);
    const id = await this.harness.commit(async (tx) => {
      const state = await tx.doc(TelegramState);
      if (requestId && state.commands?.[requestId]) return undefined;
      const created = await tx.createConversation({ ownership: { kind: "ownerless" } });
      await configure(tx, created.id, {
        ...this.initialAgent, model: current.model, thinkingLevel: current.thinkingLevel, cwd: current.cwd,
      });
      state.conversationId = created.id;
      if (requestId) {
        state.commands ??= {};
        state.commands[requestId] = { kind: "new", conversationId: created.id };
      }
      return created.id;
    }, BACKGROUND_CONTEXT);
    if (id === undefined) return;
    const conversation = await this.harness.conversation(id, BACKGROUND_CONTEXT);
    if (!conversation) throw new Error(`Missing durable conversation ${id}`);
    this.view.dispose();
    await this.bind(conversation);
  }

  async setModel(model: Model<string>): Promise<void> {
    if (this.isStreaming) throw new Error("Cannot change models while Pi is busy");
    await this.conversation.configure({ model: { provider: model.provider, modelId: model.id } }, BACKGROUND_CONTEXT);
    this.currentModel = model;
  }

  async abort(requestId?: string): Promise<void> {
    if (!requestId) {
      this.abortRequestedTurnId = this.runningTurnId;
      return this.conversation.abort(BACKGROUND_CONTEXT);
    }
    // Persist the original target before aborting. A redelivered Stop must not
    // abort a later Telegram turn or a later manual compaction.
    const receipt = await this.harness.commit(async (tx) => {
      const state = await tx.doc(TelegramState);
      const existing = state.commands?.[requestId];
      if (existing?.kind === "stop") return toJson(existing);
      const live = await tx.doc(LiveDoc, this.conversationId);
      const value = toJson({
        kind: "stop" as const, turnId: this.runningTurnId ?? (live.run ? state.turns[0]?.id : undefined),
        compactionIds: (live.compactions ?? []).map((item) => item.taskId),
      });
      state.commands ??= {};
      state.commands[requestId] = value;
      return value;
    }, BACKGROUND_CONTEXT);
    if (receipt.turnId && (await this.state.pendingTurns())[0]?.id === receipt.turnId) {
      this.abortRequestedTurnId = receipt.turnId;
      await this.conversation.abort(BACKGROUND_CONTEXT);
    } else {
      for (const id of receipt.compactionIds) await this.harness.abortTask(id, BACKGROUND_CONTEXT);
    }
  }

  async startCompaction(requestId?: string, reply?: { chatId: number; replyToMessageId: number }): Promise<TaskId<CompactionResult>> {
    const previous = requestId ? await this.state.command(requestId) : undefined;
    if (previous?.kind === "compact") return previous.taskId;
    if (this.isStreaming) throw new Error("Cannot compact while Pi is busy");
    const id = await this.harness.commit(async (tx) => {
      const state = await tx.doc(TelegramState);
      const existing = requestId ? state.commands?.[requestId] : undefined;
      if (existing?.kind === "compact") return existing.taskId;
      const live = await tx.doc(LiveDoc, this.conversationId);
      const taskId = await tx.createTask(CompactionTask, { reason: "manual" }, {
        ownership: { kind: "conversation" }, conversationId: this.conversationId,
      });
      live.compactions ??= [];
      live.compactions.push({ taskId, reason: "manual", blocking: false, attempt: 1 });
      if (requestId && reply) {
        state.commands ??= {};
        state.commands[requestId] = { kind: "compact", taskId, ...reply };
      }
      return taskId;
    }, BACKGROUND_CONTEXT);
    this.harness.resume();
    return id;
  }

  async waitForCompaction(id: TaskId<CompactionResult>): Promise<void> {
    const { outcome } = (await this.harness.waitForTask(id, BACKGROUND_CONTEXT)).state;
    if (outcome.status !== "completed")
      throw new Error(outcome.status === "failed" || outcome.status === "faulted" ? outcome.error.message : `Compaction ${outcome.status}`);
    if (outcome.result.submissionId !== undefined) {
      const submission = await this.harness.submission(outcome.result.submissionId, BACKGROUND_CONTEXT);
      const placed = await submission?.wait(BACKGROUND_CONTEXT);
      if (placed?.status !== "done") throw new Error("Compaction summary was not applied");
    }
  }

  async compact(): Promise<void> {
    const id = await this.startCompaction();
    this.activeOperation = true;
    try {
      await this.waitForCompaction(id);
    } finally {
      this.activeOperation = false;
    }
  }

  async getStatus(): Promise<TelegramAgentStatus> {
    const context = await this.conversation.context(BACKGROUND_CONTEXT);
    const usage = this.view.value.docs["pi.usage"] as {
      models?: Record<string, { cost: { total: number } }>;
      tools?: Record<string, { cost: { total: number } }>;
    } | undefined;
    const lastAssistant = [...context.messages].reverse().find((message) => message.role === "assistant");
    return {
      totalMessages: context.messages.filter((message) => message.role !== "system").length,
      cost: [...Object.values(usage?.models ?? {}), ...Object.values(usage?.tools ?? {})]
        .reduce((sum, entry) => sum + entry.cost.total, 0),
      contextTokens: lastAssistant?.usage.totalTokens,
      contextWindow: this.model?.contextWindow,
    };
  }

  async close(): Promise<void> {
    await this.events?.stop();
    this.view.dispose();
    this.listeners.clear();
    // Closing suspends work; aborting would permanently settle the pending input.
    await this.harness.close(BACKGROUND_CONTEXT);
  }

  private async bind(conversation: Conversation): Promise<void> {
    this.conversation = conversation;
    const agent = await conversation.agent(BACKGROUND_CONTEXT);
    this.currentModel = agent.model ? this.models.getModel(agent.model.provider, agent.model.modelId) : undefined;
    this.view = await conversation.viewState(BACKGROUND_CONTEXT);
  }

  private publish(event: AgentEvent): void {
    for (const listener of this.listeners) listener(event);
  }
}
