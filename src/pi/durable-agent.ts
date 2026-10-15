import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Model, Models } from "@earendil-works/pi-ai";
import {
  AssistantEntry,
  Harness,
  watchEvents,
  type AgentChange,
  type AgentEvent,
  type AgentEventStream,
  type Conversation,
  type HarnessOptions,
  type Storage,
} from "@earendil-works/pi-durable";

import type { PendingTelegramTurn, QueuedAttachment, TelegramMessage } from "../telegram/types";
import { DurableTelegramState, TelegramState } from "./durable-state";
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

export class DurableTelegramAgent {
  readonly state: DurableTelegramState;
  private conversation!: Conversation;
  private view!: Awaited<ReturnType<Conversation["viewState"]>>;
  private events: AgentEventStream | undefined;
  private readonly listeners = new Set<(event: AgentEvent) => void>();
  private activeOperation = false;
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
        (await tx.doc(TelegramState)).conversationId = conversation.id;
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
    try {
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
      const settled = await submission.wait(BACKGROUND_CONTEXT);
      if (settled.status === "unanswered") {
        return settled.reason === "aborted"
          ? { aborted: true, queuedAttachments: [] }
          : {
              error: typeof settled.detail === "string" ? settled.detail : `Pi could not answer: ${settled.reason}`,
              queuedAttachments: [],
            };
      }
      if (settled.type !== "input") throw new Error("Expected an input submission");
      const answer = await this.conversation.commit((tx) => tx.entry(AssistantEntry, settled.answer), BACKGROUND_CONTEXT);
      const message = answer?.model?.find((item) => item.role === "assistant");
      const saved = (await this.state.pendingTurns()).find((pending) => pending.id === turn.id);
      return { text: message ? getMessageText(message) : undefined, queuedAttachments: saved?.queuedAttachments ?? [] };
    } finally {
      this.activeOperation = false;
      if (this.events === events) this.events = undefined;
      await events?.stop();
    }
  }

  async newSession(): Promise<void> {
    if (this.isStreaming || (await this.state.pendingTurns()).length || (await this.state.bufferedMedia()).length)
      throw new Error("Cannot start a new chat while Telegram work is pending");
    const current = await this.conversation.agent(BACKGROUND_CONTEXT);
    const conversation = await this.harness.createConversation({
      ownership: { kind: "ownerless" },
      agent: { ...this.initialAgent, model: current.model, thinkingLevel: current.thinkingLevel, cwd: current.cwd },
      init: async (tx, id) => {
        (await tx.doc(TelegramState)).conversationId = id;
      },
    }, BACKGROUND_CONTEXT);
    this.view.dispose();
    await this.bind(conversation);
  }

  async setModel(model: Model<string>): Promise<void> {
    if (this.isStreaming) throw new Error("Cannot change models while Pi is busy");
    await this.conversation.configure({ model: { provider: model.provider, modelId: model.id } }, BACKGROUND_CONTEXT);
    this.currentModel = model;
  }

  async abort(): Promise<void> {
    await this.conversation.abort(BACKGROUND_CONTEXT);
  }

  async compact(): Promise<void> {
    if (this.isStreaming) throw new Error("Cannot compact while Pi is busy");
    this.activeOperation = true;
    try {
      const id = await this.conversation.compact(undefined, BACKGROUND_CONTEXT);
      const { outcome } = (await this.harness.waitForTask(id, BACKGROUND_CONTEXT)).state;
      if (outcome.status !== "completed")
        throw new Error(outcome.status === "failed" || outcome.status === "faulted" ? outcome.error.message : `Compaction ${outcome.status}`);
      if (outcome.result.submissionId !== undefined) {
        const submission = await this.harness.submission(outcome.result.submissionId, BACKGROUND_CONTEXT);
        const placed = await submission?.wait(BACKGROUND_CONTEXT);
        if (placed?.status !== "done") throw new Error("Compaction summary was not applied");
      }
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
