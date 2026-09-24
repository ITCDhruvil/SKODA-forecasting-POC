import type { ReasoningEffort } from './responsesClient';

export interface ChatConfig {
  dataModel: string;
  routerModel: string;
  webModel: string;
  routerEffort?: ReasoningEffort;
  webEffort?: ReasoningEffort;
  webSearchEnabled: boolean;
  routerTimeoutMs: number;
  dataTimeoutMs: number;
  webTimeoutMs: number;
}

const EFFORTS: readonly ReasoningEffort[] = ['minimal', 'low', 'medium', 'high'];

function parseEffort(value: string | undefined): ReasoningEffort | undefined {
  const v = value?.trim().toLowerCase();
  return EFFORTS.find((e) => e === v);
}

export function loadChatConfig(env: Record<string, string | undefined> = process.env): ChatConfig {
  const dataModel =
    env.OPENAI_MODEL || env.AZURE_OPENAI_CHAT_DEPLOYMENT || 'gpt-4o-mini';
  return {
    dataModel,
    routerModel: env.OPENAI_ROUTER_MODEL || env.AZURE_OPENAI_FAST_DEPLOYMENT || dataModel,
    // Falls back to the data model for typing only. Web search is not enabled without an explicit
    // web model, because the gpt-4o/gpt-4.1 family rejects the web_search domain filter (spec section 11).
    webModel: env.OPENAI_WEB_MODEL || dataModel,
    routerEffort: parseEffort(env.OPENAI_ROUTER_EFFORT),
    webEffort: parseEffort(env.OPENAI_WEB_EFFORT),
    webSearchEnabled: env.WEB_SEARCH_ENABLED === 'true' && Boolean(env.OPENAI_WEB_MODEL),
    routerTimeoutMs: 5_000,
    dataTimeoutMs: 25_000,
    webTimeoutMs: 40_000,
  };
}
