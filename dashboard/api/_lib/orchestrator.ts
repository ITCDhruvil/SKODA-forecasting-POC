import type { ChatConfig } from './config';
import { runChatLoop, type ChatMessage } from './chatLoop';
import { ResponsesChatClient, type ResponsesApi } from './responsesClient';
import { routeMessage, stubOf, type Mode } from './router';
import { buildSystemPrompt } from './systemPrompt';
import { buildToolset } from './toolsets';
import { ALLOWED_DOMAINS, type WebSource } from './webSources';

export interface IncomingMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface ChatRequest {
  messages: IncomingMessage[];
  webEnabled: boolean;
  ip: string;
}

export interface ChatResult {
  reply: string;
  mode: Mode;
  usedWeb: boolean;
  sources: WebSource[];
}

export interface OrchestratorDeps {
  api: ResponsesApi;
  config: ChatConfig;
  checkBudget: (ip: string) => Promise<{ allowed: boolean }>;
  now?: () => number;
}

export const TOTAL_BUDGET_MS = 55_000;
export const MIN_FALLBACK_MS = 8_000;
export const MAX_SEARCHES = 2;
export const LIMIT_NOTE = '_Live news is limited right now, so this answer uses dashboard data only._';
export const UNREACHABLE_NOTE = "_I couldn't reach live news just now, so this answer uses dashboard data only._";

interface RunResult {
  reply: string;
  sources: WebSource[];
  searches: number;
}

export async function answer(req: ChatRequest, deps: OrchestratorDeps): Promise<ChatResult> {
  const now = deps.now ?? Date.now;
  const started = now();
  const { api, config } = deps;
  const webAllowed = config.webSearchEnabled && req.webEnabled;

  const lastUser = [...req.messages].reverse().find((m) => m.role === 'user');
  const lastAssistant = [...req.messages].reverse().find((m) => m.role === 'assistant');

  let mode = await routeMessage(
    { api, model: config.routerModel, timeoutMs: config.routerTimeoutMs, reasoningEffort: config.routerEffort },
    { lastUserMessage: lastUser?.content ?? '', lastReplyStub: stubOf(lastAssistant?.content), webAllowed },
  );

  let note = '';
  if (mode === 'web') {
    const budget = await deps.checkBudget(req.ip);
    if (!budget.allowed) {
      mode = 'data';
      note = LIMIT_NOTE;
    }
  }

  const run = async (m: Mode): Promise<RunResult> => {
    const toolset = buildToolset(m);
    const isWeb = m === 'web';
    const remaining = TOTAL_BUDGET_MS - (now() - started);
    const client = new ResponsesChatClient({
      api,
      model: isWeb ? config.webModel : config.dataModel,
      tools: toolset.definitions,
      webSearch: toolset.webSearch ? { allowedDomains: ALLOWED_DOMAINS, maxSearches: MAX_SEARCHES } : null,
      timeoutMs: Math.min(isWeb ? config.webTimeoutMs : config.dataTimeoutMs, Math.max(1000, remaining)),
      reasoningEffort: isWeb ? config.webEffort : undefined,
    });
    const messages: ChatMessage[] = [{ role: 'system', content: buildSystemPrompt(m) }, ...req.messages];
    const reply = await runChatLoop(client, toolset.handlers, messages);
    return { reply, sources: client.getSources(), searches: client.getSearchCount() };
  };

  let result: RunResult;
  try {
    result = await run(mode);
  } catch (err) {
    if (mode !== 'web') throw err;
    console.error('web mode failed, falling back to data mode:', err);
    if (TOTAL_BUDGET_MS - (now() - started) < MIN_FALLBACK_MS) throw err;
    mode = 'data';
    note = UNREACHABLE_NOTE;
    result = await run('data');
  }

  const usedWeb = mode === 'web' && result.searches > 0;
  console.info(
    JSON.stringify({
      event: 'chat',
      mode,
      usedWeb,
      searches: result.searches,
      sources: result.sources.length,
      latencyMs: now() - started,
    }),
  );

  return {
    reply: note ? `${result.reply}\n\n${note}` : result.reply,
    mode,
    usedWeb,
    sources: usedWeb ? result.sources : [],
  };
}
