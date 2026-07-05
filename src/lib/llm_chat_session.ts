import { Tool } from "./tool_types";
import defaultSystemPromptTemplate from "../prompts/default_system_prompt.md";
import {
  buildChatCompletionsUrl,
  buildCheckpointRequestBody,
  normalizeOpenAIBaseUrl,
} from "./llm_endpoint";

export interface LLMHistoryItem {
  role: "system" | "user" | "assistant" | "tool" | "reasoning";
  content: string | null | any[];
  tool_call_id?: string | null;
  tool_calls?: ToolCallAccumulator[] | null;
}

type ToolCallAccumulator = {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
};

export function buildSystemPrompt(additionalPrompt?: string): string {
  const parts = [defaultSystemPromptTemplate.trim()];
  const extra = additionalPrompt?.trim();
  if (extra) {
    parts.push(extra);
  }
  return parts.join("\n\n");
}

function buildRequestHeaders(apiToken?: string): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  const trimmedToken = apiToken?.trim();
  if (trimmedToken) {
    headers.Authorization = `Bearer ${trimmedToken}`;
  }
  return headers;
}

export async function checkpointLLMEndpoint(
  baseUrl: string,
  apiToken?: string,
  model = "default",
): Promise<void> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);

  try {
    const response = await fetch(buildChatCompletionsUrl(baseUrl), {
      method: "POST",
      headers: buildRequestHeaders(apiToken),
      signal: controller.signal,
      body: JSON.stringify(buildCheckpointRequestBody(model)),
    });

    if (!response.ok) {
      const errorBody = await response.text();
      throw new Error(
        `Checkpoint API error: ${response.status} ${response.statusText}${errorBody ? ` - ${errorBody}` : ""}`,
      );
    }

    await response.text();
  } finally {
    clearTimeout(timeout);
  }
}

export class LLMChatSession {
  private history: LLMHistoryItem[] = [];
  private warmupPromise: Promise<void> | null = null;
  private baseUrl: string;
  private apiToken: string;
  private model: string;
  private extraParameters: Record<string, any> = {};
  toolCalls: { name: string; args: any; output: string }[] = [];
  tools: Tool[];
  toolSchema: any[];

  constructor(
    baseUrl: string,
    systemPrompt: string,
    tools: Tool[],
    apiToken?: string,
    model = "default",
    extraParameters?: Record<string, any>,
    history?: LLMHistoryItem[],
  ) {
    this.baseUrl = normalizeOpenAIBaseUrl(baseUrl);
    this.apiToken = apiToken?.trim() ?? "";
    this.model = model.trim() || "default";
    this.extraParameters = extraParameters || {};
    this.tools = tools;
    this.toolSchema = buildToolSchema(this.tools || []);

    if (systemPrompt) {
      this.history.push({
        role: "system",
        content: systemPrompt,
      });
    }
    if (history) {
      this.history.push(...history);
    }
  }

  async chat(options: {
    userMessage: string;
    image?: string | null;
    silent?: boolean;
    onToken?: (token: string) => Promise<void>;
    onReasoningToken?: (token: string) => Promise<void>;
    onToolCall?: (
      toolCallId: string,
      toolName: string,
      args: any,
    ) => Promise<boolean>;
    onToolResult?: (
      toolCallId: string,
      toolName: string,
      args: any,
      output: string,
    ) => Promise<void>;
    onStopReason?: (
      reason: "tool_calls" | "stop",
      timings: LlamaCppTimings,
    ) => Promise<void>;
    onPushHistory?: (message: LLMHistoryItem, index: number) => Promise<void>;
    onToolError?: (
      toolCallId: string,
      fullText: string,
      toolName: string,
      args: any,
      errorMessage: string,
      stackTrace: string,
    ) => Promise<void>;
    simulatedMode?: boolean;
    signal?: AbortSignal;
  }) {
    const pushHistory = async (message: LLMHistoryItem) => {
      this.history.push(message);
      if (options.onPushHistory && !options.simulatedMode) {
        await options.onPushHistory(message, this.history.length - 1);
      }
    };

    if (!options.silent) {
      console.log(options.userMessage);
      if (options.image) {
        console.log(
          `With image: ${options.image.length} characters of data URL`,
        );
      }
    }

    if (options.image && options.userMessage) {
      const content = [
        { type: "text", text: options.userMessage },
        { type: "image_url", image_url: { url: options.image } },
      ];

      await pushHistory({ role: "user", content });
    } else if (options.image) {
      const content = [
        { type: "image_url", image_url: { url: options.image } },
      ];
      await pushHistory({ role: "user", content });
    } else {
      await pushHistory({ role: "user", content: options.userMessage });
    }

    while (true) {
      this.throwIfAborted(options.signal);
      const response = await fetch(buildChatCompletionsUrl(this.baseUrl), {
        method: "POST",
        headers: buildRequestHeaders(this.apiToken),
        signal: options.signal,
        body: JSON.stringify({
          model: this.model,
          messages: this.history.filter((h) => h.role !== "reasoning"),
          stream: true,
          tools: this.toolSchema,
          ...this.extraParameters,
        }),
      });
      if (!response.ok) {
        console.log(this.history);
        throw new Error(`API error: ${response.status} ${response.statusText}`);
      }
      const reader = response.body!.getReader();
      const decoder = new TextDecoder();
      let fullContent = "";
      let fullReasoning = "";
      const requestedToolCalls: Record<number, ToolCallAccumulator> = {};
      let finishReason: "tool_calls" | "stop" | null = null;
      let lastStdoutWasReasoning = false;
      while (true) {
        this.throwIfAborted(options.signal);
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = decoder.decode(value, { stream: true });
        const lines = chunk.split("\n").filter((l) => l.startsWith("data: "));
        for (const line of lines) {
          const data = line.slice(6);
          if (data === "[DONE]") continue;
          try {
            const parsed = JSON.parse(data);
            const choice = parsed.choices?.[0];
            if (!choice) continue;
            if (choice.finish_reason) {
              const timing: LlamaCppTimings = parsed.timings;
              finishReason = choice.finish_reason;
              if (options.onStopReason) {
                await options.onStopReason(choice.finish_reason, timing);
              }
              break;
            }
            const delta = choice.delta;
            if (!delta) continue;
            if (delta.tool_calls) {
              for (const tc of delta.tool_calls) {
                const i = tc.index;
                if (!requestedToolCalls[i]) {
                  requestedToolCalls[i] = {
                    id: tc.id,
                    type: "function",
                    function: { name: tc.function?.name ?? "", arguments: "" },
                  };
                }
                if (tc.function?.arguments) {
                  requestedToolCalls[i].function.arguments +=
                    tc.function.arguments;
                }
              }
            }
            if (delta.reasoning) {
              throw new Error("different format");
            }
            if (delta.reasoning_content) {
              fullReasoning += delta.reasoning_content;
              if (!options.silent) {
                process.stdout.write(delta.reasoning_content);
                lastStdoutWasReasoning = true;
              }
              if (options.onReasoningToken) {
                await options.onReasoningToken(delta.reasoning_content);
              }
            } else if (delta.content) {
              fullContent += delta.content;
              if (!options.silent) {
                if (lastStdoutWasReasoning) {
                  process.stdout.write("\n");
                  lastStdoutWasReasoning = false;
                }
                process.stdout.write(delta.content);
              }
              if (options.onToken) await options.onToken(delta.content);
            }
          } catch {
            console.warn("Failed to parse chunk:", data);
            // skip malformed chunks
          }
        }
      }

      if (fullReasoning)
        await pushHistory({ role: "reasoning", content: fullReasoning });

      if (finishReason === "tool_calls") {
        // Snapshot history length before pushing the assistant tool_calls message.
        // If we are aborted mid-tool-execution, we must roll back to keep the
        // conversation valid – an assistant message with tool_calls MUST be
        // followed by exactly one tool message per tool_call.
        const historyBeforeToolCalls = this.history.length;
        await pushHistory({
          role: "assistant",
          content: fullContent.trim() ? fullContent : null,
          tool_calls: Object.values(requestedToolCalls),
        });
        try {
          for (const tc of Object.values(requestedToolCalls)) {
          if (!this.tools) continue;
          const name = tc.function.name || "unknown";
          const args = JSON.parse(tc.function.arguments);
          const toolCallId = tc.id || crypto.randomUUID();
          const tool = this.tools.find((t) => t.name() === name);
          if (!tool) throw new Error(`Unknown tool requested: ${name}`);
          const toolName = tool.name();
          let toolOutput: string;
          let allow = true;
          let stopAfterToolResult = false;
          if (!options.silent)
            console.log(`Tool call: ${toolName} with args`, args);
          if (options.onToolCall) {
            allow = await options.onToolCall(toolCallId, toolName, args);
          }
          if (!allow) {
            toolOutput = `Tool ${toolName} call was not allowed because the user declined it. Current response stopped.`;
            stopAfterToolResult = true;
          } else {
            try {
              this.throwIfAborted(options.signal);
              if (options.simulatedMode && tool.execSimulated) {
                toolOutput = await tool.execSimulated(args);
              } else if (options.simulatedMode) {
                toolOutput = `Tool ${toolName} executed successfully.`;
              } else {
                toolOutput = await tool.exec(args, {
                  signal: options.signal,
                  toolCallId,
                  onStateChange: options.onToolResult
                    ? (state) =>
                        options.onToolResult!(
                          toolCallId,
                          toolName,
                          args,
                          state.output ?? "",
                        )
                    : undefined,
                });
              }
              this.toolCalls.push({ name: toolName, args, output: toolOutput });
            } catch (error) {
              if (this.isAbortError(error)) {
                throw error;
              }

              const errorMessage =
                error instanceof Error ? error.message : String(error);
              const stackTrace =
                error instanceof Error && error.stack
                  ? error.stack
                  : "No stack trace available";

              let fullDetails = ``;
              fullDetails += `Error executing tool ${toolName}:\n`;
              fullDetails += `Arguments: ${JSON.stringify(args)}\n`;
              fullDetails += `Message: ${errorMessage}\n`;
              fullDetails += `Stack Trace:\n${stackTrace}\n`;

              if (options.onToolError)
                await options.onToolError(
                  toolCallId,
                  fullDetails,
                  toolName,
                  args,
                  errorMessage,
                  stackTrace,
                );

              console.error(fullDetails);
              toolOutput = `Error executing tool ${toolName}: ${errorMessage}`;
            }
          }
          if (!options.silent) {
            console.log(`Tool result for ${toolName}`);
            console.log(toolOutput);
          }
          if (options.onToolResult) {
            await options.onToolResult(toolCallId, toolName, args, toolOutput);
          }
          console.log("Tool output:", toolOutput);
          await pushHistory({
            role: "tool",
            content: toolOutput,
            tool_call_id: toolCallId,
          });
          if (stopAfterToolResult) {
            return fullContent;
          }
        }
        } catch (error) {
          // If the user aborted during tool execution, roll back history to
          // remove the orphaned assistant tool_calls message (and any partial
          // tool messages), keeping the conversation valid for the next request.
          if (this.isAbortError(error)) {
            this.history.splice(historyBeforeToolCalls);
          }
          throw error;
        }
        continue;
      } else if (finishReason === "stop") {
        // Normal completion
        await pushHistory({ role: "assistant", content: fullContent.trim() });
        if (!options.silent) process.stdout.write("\n");
        return fullContent;
      } else {
        throw new Error("Unknown finish reason: " + finishReason);
      }
    }
  }

  async warmup(): Promise<void> {
    if (this.warmupPromise) {
      return this.warmupPromise;
    }

    this.warmupPromise = (async () => {
      const warmupMessages: LLMHistoryItem[] = [
        ...this.history,
        {
          role: "user",
          content: "Warm up the session cache for the next real user message.",
        },
      ];

      const response = await fetch(buildChatCompletionsUrl(this.baseUrl), {
        method: "POST",
        headers: buildRequestHeaders(this.apiToken),
        body: JSON.stringify({
          model: this.model,
          messages: warmupMessages,
          stream: false,
          n_predict: 0,
          cache_prompt: true,
        }),
      });

      if (!response.ok) {
        const errorBody = await response.text();
        throw new Error(
          `Warmup API error: ${response.status} ${response.statusText}${errorBody ? ` - ${errorBody}` : ""}`,
        );
      }
      await response.text();
    })();

    try {
      await this.warmupPromise;
    } catch (error) {
      this.warmupPromise = null;
      throw error;
    }
  }
  getHistory(): LLMHistoryItem[] {
    return structuredClone(this.history);
  }

  private throwIfAborted(signal?: AbortSignal): void {
    if (signal?.aborted) {
      throw new DOMException("Operation was aborted.", "AbortError");
    }
  }

  private isAbortError(error: unknown): boolean {
    return (
      (error instanceof DOMException && error.name === "AbortError") ||
      (error instanceof Error && error.name === "AbortError")
    );
  }
}

function buildToolSchema(tools: Tool[]) {
  return tools.map((tool) => {
    const args = tool.arguments();
    return {
      type: "function",
      function: {
        name: tool.name(),
        description: tool.description(),
        parameters: {
          type: "object",
          properties: args.reduce(
            (acc, arg) => {
              acc[arg.name] = {
                type: arg.type,
                description: `${arg.description}${arg.required ? " (required)" : ""}`,
                ...(arg.type === "array"
                  ? {
                      items: {
                        type: "string",
                      },
                    }
                  : {}),
              };
              return acc;
            },
            {} as Record<string, any>,
          ),
          required: tool
            .arguments()
            .filter((arg) => arg.required)
            .map((arg) => arg.name),
        },
      },
    };
  });
}

interface LlamaCppTimings {
  cache_n: number;
  prompt_n: number;
  prompt_ms: number;
  prompt_per_token_ms: number;
  prompt_per_second: number;
  predicted_n: number;
  predicted_ms: number;
  predicted_per_token_ms: number;
  predicted_per_second: number;
}
