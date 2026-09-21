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
  /** Reports the mode chosen for the main run (after routing and the web-budget check), and again with 'data' if web mode fails and the data fallback starts. */
  onMode?: (mode: Mode) => void;
  /**
   * Called once at the end of a successful answer with the final mode and the total tokens the API reported for
   * every model run of the request (a failed web run plus the data fallback counts both). The router's own call
   * (a few hundred tokens) is not included, so the figures are an approximation. Failures and hangs are contained.
   */
  recordUsage?: (kind: Mode, tokens: number) => void | Promise<void>;
}

export const TOTAL_BUDGET_MS = 55_000;
export const MIN_FALLBACK_MS = 8_000;
export const MAX_SEARCHES = 2;
/** Longest an answer waits for the usage counters to be written, so a slow store cannot hold a finished answer. */
export const RECORD_USAGE_GRACE_MS = 1_500;
export const LIMIT_NOTE = '_Live news is limited right now, so this answer uses dashboard data only._';
export const UNREACHABLE_NOTE = "_I couldn't reach live news just now, so this answer uses dashboard data only._";
export const NO_SEARCH_NOTE = "_I didn't run a live news search for this question, so this answer uses dashboard data only._";

interface RunResult {
  reply: string;
  sources: WebSource[];
  searches: number;
}

/** Calls recordUsage and waits for it for at most RECORD_USAGE_GRACE_MS. Never throws. */
async function reportUsage(record: (kind: Mode, tokens: number) => void | Promise<void>, kind: Mode, tokens: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const grace = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, RECORD_USAGE_GRACE_MS);
    });
    await Promise.race([Promise.resolve().then(() => record(kind, tokens)), grace]);
  } catch {
    // Usage stats are best effort: a failing store must never break an answer.
  } finally {
    clearTimeout(timer);
  }
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

  // A failing observer (for example a closed client connection) must never break the answer.
  const reportMode = (m: Mode) => {
    try {
      deps.onMode?.(m);
    } catch {
      // ignored on purpose
    }
  };
  reportMode(mode);

  // Every client created for this request, so the usage of a failed web run is counted too.
  const clients: ResponsesChatClient[] = [];
  const run = async (m: Mode): Promise<RunResult> => {
    const toolset = buildToolset(m);
    const isWeb = m === 'web';
    const client = new ResponsesChatClient({
      api,
      model: isWeb ? config.webModel : config.dataModel,
      tools: toolset.definitions,
      webSearch: toolset.webSearch ? { allowedDomains: ALLOWED_DOMAINS, maxSearches: MAX_SEARCHES } : null,
      timeoutMs: isWeb ? config.webTimeoutMs : config.dataTimeoutMs,
      deadline: started + TOTAL_BUDGET_MS,
      now,
      reasoningEffort: isWeb ? config.webEffort : undefined,
      forceSearchFirst: toolset.webSearch,
    });
    clients.push(client);
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
    reportMode('data');
    result = await run('data');
  }

  // Web mode that never searched must say so. A search that produced no allow-listed source at all (neither
  // cited annotations nor consulted URLs from the search call) gets no note: the reply then states what it
  // found. Annotations can be missing on their own when the forced search shared a response with a tool
  // call, which is why consulted sources are collected too.
  if (mode === 'web' && result.searches === 0) note = NO_SEARCH_NOTE;

  const usedWeb = mode === 'web' && result.searches > 0 && result.sources.length > 0;
  if (deps.recordUsage) {
    const total = clients.reduce((sum, c) => sum + c.getUsage().totalTokens, 0);
    await reportUsage(deps.recordUsage, mode, total);
  }

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
