export type MemoryCoreMessageInput = {
  role: string;
  content: string;
};

export type MemoryCoreMessage = {
  id: string;
  role: string;
  content: string;
  timestamp?: string;
  score?: number;
};

export type MemoryCoreClientOptions = {
  baseUrl?: string;
  serviceId?: string;
  gatewayKey: string;
  fetchImpl?: typeof fetch;
};

export type ConversationScope = {
  teamId: string;
  agentId: string;
  userId: string;
  sessionId: string;
};

export type ConversationAddInput = ConversationScope & {
  messages: MemoryCoreMessageInput[];
};

export type ConversationSearchInput = ConversationScope & {
  query: string;
  limit?: number;
};

export type ConversationDeleteInput = ConversationScope & {
  messageIds: string[];
};

export type AtomicSearchInput = ConversationScope & {
  query: string;
  limit?: number;
  type?: string;
};

export type AtomicSearchItem = {
  id?: string;
  content?: string;
  type?: string;
  background?: string;
  version?: number;
  score?: number;
  created_at?: string;
  updated_at?: string;
  team_id?: string;
  user_id?: string;
  agent_id?: string;
  task_id?: string;
};

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireNonBlank(name: string, value: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${name} must be a nonblank string`);
  }
  return value;
}

function normalizeScope(input: ConversationScope): {
  team_id: string;
  agent_id: string;
  user_id: string;
  session_id: string;
} {
  return {
    team_id: requireNonBlank("teamId", input.teamId),
    agent_id: requireNonBlank("agentId", input.agentId),
    user_id: requireNonBlank("userId", input.userId),
    session_id: requireNonBlank("sessionId", input.sessionId),
  };
}

function requireDataRecord(operation: string, data: unknown): JsonRecord {
  if (!isRecord(data)) {
    throw new Error(`MemoryCore ${operation} invalid response`);
  }
  return data;
}

export class MemoryCoreClient {
  readonly baseUrl: string;
  readonly serviceId: string;
  readonly #gatewayKey: string;
  readonly #fetchImpl: typeof fetch;

  constructor(options: MemoryCoreClientOptions) {
    const baseUrl = options.baseUrl ?? "http://127.0.0.1:8420";
    const serviceId = options.serviceId ?? "local-memory-core";

    this.baseUrl = requireNonBlank("baseUrl", baseUrl).replace(/\/+$/, "");
    this.serviceId = requireNonBlank("serviceId", serviceId);
    this.#gatewayKey = requireNonBlank("gatewayKey", options.gatewayKey);
    this.#fetchImpl = options.fetchImpl ?? fetch;
  }

  async conversationAdd(input: ConversationAddInput): Promise<{ acceptedIds: string[] }> {
    if (!Array.isArray(input.messages) || input.messages.length === 0) {
      throw new Error("messages must contain at least one item");
    }

    const messages = input.messages.map((message, index) => ({
      role: requireNonBlank(`messages[${index}].role`, message.role),
      content: requireNonBlank(`messages[${index}].content`, message.content),
    }));

    return this.#post(
      "conversationAdd",
      "/v3/conversation/add",
      {
        ...normalizeScope(input),
        messages,
      },
      (data) => {
        const record = requireDataRecord("conversationAdd", data);
        const accepted = record.accepted_ids;
        if (!Array.isArray(accepted) || accepted.some((id) => typeof id !== "string")) {
          throw new Error("MemoryCore conversationAdd invalid response");
        }
        return { acceptedIds: [...accepted] as string[] };
      },
    );
  }

  async conversationSearch(input: ConversationSearchInput): Promise<{ messages: MemoryCoreMessage[] }> {
    const limit = input.limit ?? 20;
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw new Error("limit must be an integer from 1 to 100");
    }

    return this.#post(
      "conversationSearch",
      "/v3/conversation/search",
      {
        ...normalizeScope(input),
        query: requireNonBlank("query", input.query),
        limit,
      },
      (data) => {
        const record = requireDataRecord("conversationSearch", data);
        const rawMessages = record.messages;
        if (!Array.isArray(rawMessages)) {
          throw new Error("MemoryCore conversationSearch invalid response");
        }

        const messages = rawMessages.map((message) => {
          if (!isRecord(message)) {
            throw new Error("MemoryCore conversationSearch invalid response");
          }
          const id = message.id;
          const role = message.role;
          const content = message.content;
          if (typeof id !== "string" || typeof role !== "string" || typeof content !== "string") {
            throw new Error("MemoryCore conversationSearch invalid response");
          }

          const normalized: MemoryCoreMessage = { id, role, content };
          if (typeof message.timestamp === "string") {
            normalized.timestamp = message.timestamp;
          }
          if (typeof message.score === "number") {
            normalized.score = message.score;
          }
          return normalized;
        });

        return { messages };
      },
    );
  }

  async conversationDelete(input: ConversationDeleteInput): Promise<{ deletedCount: number }> {
    if (!Array.isArray(input.messageIds) || input.messageIds.length === 0) {
      throw new Error("messageIds must contain at least one item");
    }
    const messageIds = input.messageIds.map((id, index) =>
      requireNonBlank(`messageIds[${index}]`, id),
    );

    return this.#post(
      "conversationDelete",
      "/v3/conversation/delete",
      {
        ...normalizeScope(input),
        message_ids: messageIds,
      },
      (data) => {
        const record = requireDataRecord("conversationDelete", data);
        const deletedCount = record.deleted_count;
        if (
          typeof deletedCount !== "number" ||
          !Number.isInteger(deletedCount) ||
          deletedCount < 0
        ) {
          throw new Error("MemoryCore conversationDelete invalid response");
        }
        return { deletedCount };
      },
    );
  }

  async atomicSearch(input: AtomicSearchInput): Promise<{ items: AtomicSearchItem[] }> {
    const limit = input.limit ?? 20;
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw new Error("limit must be an integer from 1 to 100");
    }

    const body: JsonRecord = {
      ...normalizeScope(input),
      query: requireNonBlank("query", input.query),
      limit,
    };
    if (input.type !== undefined) {
      body.type = requireNonBlank("type", input.type);
    }
    return this.#post("atomicSearch", "/v3/atomic/search", body, (data) => {
      const record = requireDataRecord("atomicSearch", data);
      if (!Array.isArray(record.items)) {
        throw new Error("MemoryCore atomicSearch invalid response");
      }

      const stringFields = [
        "id",
        "content",
        "type",
        "background",
        "created_at",
        "updated_at",
        "team_id",
        "user_id",
        "agent_id",
        "task_id",
      ] as const;
      const numberFields = ["version", "score"] as const;
      const items = record.items.map((item) => {
        if (!isRecord(item)) {
          throw new Error("MemoryCore atomicSearch invalid response");
        }
        const normalized: AtomicSearchItem = {};
        for (const field of stringFields) {
          if (typeof item[field] === "string") {
            normalized[field] = item[field];
          }
        }
        for (const field of numberFields) {
          if (typeof item[field] === "number") {
            normalized[field] = item[field];
          }
        }
        return normalized;
      });

      return { items };
    });
  }

  async #post<T>(
    operation: string,
    path: string,
    body: JsonRecord,
    normalize: (data: unknown) => T,
  ): Promise<T> {
    let response: Response;
    try {
      response = await this.#fetchImpl(`${this.baseUrl}${path}`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.#gatewayKey}`,
          "x-tdai-service-id": this.serviceId,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      });
    } catch {
      throw new Error(`MemoryCore ${operation} request failed`);
    }

    if (!response.ok) {
      throw new Error(`MemoryCore ${operation} HTTP ${response.status}`);
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new Error(`MemoryCore ${operation} invalid JSON`);
    }

    if (!isRecord(payload) || typeof payload.code !== "number") {
      throw new Error(`MemoryCore ${operation} invalid response`);
    }
    if (payload.code !== 0) {
      throw new Error(`MemoryCore ${operation} API code ${payload.code}`);
    }

    return normalize(payload.data);
  }
}
