import type { ChatClient, ChatMessage, ToolCall } from './chatLoop';
import type { ToolDefinition } from './tools';
import { dedupeSources, toWebSource, type WebSource } from './webSources';

export type ReasoningEffort = 'minimal' | 'low' | 'medium' | 'high';

export interface ResponseOutputItem {
  type: string;
  call_id?: string;
  name?: string;
  arguments?: string;
  content?: {
    type: string;
    text?: string;
    annotations?: { type: string; url?: string; title?: string }[];
  }[];
}

export interface ResponseLike {
  id: string;
  status?: string;
  output: ResponseOutputItem[];
}

/** Minimal structural view of `openai.responses`, so tests and SDK upgrades stay decoupled. */
export interface ResponsesApi {
  create(body: Record<string, unknown>, options?: { timeout?: number }): Promise<ResponseLike>;
}

export interface ResponsesClientOptions {
  api: ResponsesApi;
  model: string;
  tools: ToolDefinition[];
  webSearch?: { allowedDomains: string[]; maxSearches: number } | null;
  timeoutMs: number;
  reasoningEffort?: ReasoningEffort;
}

export function extractOutputText(response: ResponseLike): string {
  let text = '';
  for (const item of response.output ?? []) {
    if (item.type !== 'message') continue;
    for (const part of item.content ?? []) {
      if (part.type === 'output_text' && typeof part.text === 'string') text += part.text;
    }
  }
  return text;
}

function toFunctionTool(def: ToolDefinition): Record<string, unknown> {
  return {
    type: 'function',
    name: def.function.name,
    description: def.function.description,
    parameters: def.function.parameters,
    strict: false,
  };
}

/** Converts our messages (everything except the system message) to Responses input items. */
export function toInputItems(messages: ChatMessage[]): Record<string, unknown>[] {
  const items: Record<string, unknown>[] = [];
  for (const m of messages) {
    if (m.role === 'system') continue;
    if (m.role === 'tool') {
      items.push({ type: 'function_call_output', call_id: m.tool_call_id, output: m.content ?? '' });
      continue;
    }
    if (m.role === 'assistant' && m.tool_calls?.length) {
      if (m.content) items.push({ role: 'assistant', content: m.content });
      for (const tc of m.tool_calls) {
        items.push({ type: 'function_call', call_id: tc.id, name: tc.name, arguments: tc.arguments });
      }
      continue;
    }
    items.push({ role: m.role, content: m.content ?? '' });
  }
  return items;
}

function toolOutputsFrom(messages: ChatMessage[], start: number): Record<string, unknown>[] {
  return toInputItems(messages.slice(start).filter((m) => m.role === 'tool'));
}

/**
 * ChatClient over the Responses API. One instance per request: after the first call it
 * chains with `previous_response_id` and sends only new tool outputs.
 */
export class ResponsesChatClient implements ChatClient {
  private opts: ResponsesClientOptions;
  private previousResponseId: string | null = null;
  private consumed = 0;
  private sources: WebSource[] = [];
  private searchCount = 0;

  constructor(opts: ResponsesClientOptions) {
    this.opts = opts;
  }

  async createCompletion(messages: ChatMessage[]): Promise<{ content: string | null; toolCalls: ToolCall[] }> {
    const { api, model, tools, timeoutMs, reasoningEffort } = this.opts;
    const system = messages.find((m) => m.role === 'system');
    const followUp = this.previousResponseId !== null;

    const body: Record<string, unknown> = {
      model,
      input: followUp ? toolOutputsFrom(messages, this.consumed) : toInputItems(messages),
    };
    if (system?.content) body.instructions = system.content;
    if (followUp) body.previous_response_id = this.previousResponseId;
    const webSearch = this.opts.webSearch;
    const searchesLeft = webSearch ? webSearch.maxSearches - this.searchCount : 0;
    const requestTools: Record<string, unknown>[] = tools.map(toFunctionTool);
    if (webSearch && searchesLeft > 0) {
      requestTools.push({ type: 'web_search', filters: { allowed_domains: webSearch.allowedDomains } });
      body.max_tool_calls = searchesLeft;
    }
    if (requestTools.length > 0) body.tools = requestTools;
    if (reasoningEffort) body.reasoning = { effort: reasoningEffort };

    const response = await api.create(body, { timeout: timeoutMs });
    if (response.status === 'failed') throw new Error('responses api returned status failed');

    this.previousResponseId = response.id;
    // The loop appends one assistant message next, then the tool messages we must send.
    this.consumed = messages.length + 1;

    const toolCalls: ToolCall[] = [];
    for (const item of response.output ?? []) {
      if (item.type === 'function_call' && item.call_id && item.name) {
        toolCalls.push({ id: item.call_id, name: item.name, arguments: item.arguments ?? '' });
      } else if (item.type === 'web_search_call') {
        this.searchCount += 1;
      } else if (item.type === 'message') {
        for (const part of item.content ?? []) {
          for (const a of part.annotations ?? []) {
            if (a.type !== 'url_citation' || !a.url) continue;
            const source = toWebSource(a.url, a.title, webSearch?.allowedDomains ?? []);
            if (source) this.sources.push(source);
          }
        }
      }
    }
    const text = extractOutputText(response);
    return { content: text === '' ? null : text, toolCalls };
  }

  getSources(): WebSource[] {
    return dedupeSources(this.sources);
  }

  getSearchCount(): number {
    return this.searchCount;
  }
}
