import { describe, it, expect } from 'vitest';
import { loadChatConfig } from '../config';

describe('loadChatConfig', () => {
  it('defaults: data model gpt-4o-mini, router and web fall back to the data model, web search off', () => {
    const c = loadChatConfig({});
    expect(c.dataModel).toBe('gpt-4o-mini');
    expect(c.routerModel).toBe('gpt-4o-mini');
    expect(c.webModel).toBe('gpt-4o-mini');
    expect(c.webSearchEnabled).toBe(false);
    expect(c.routerEffort).toBeUndefined();
    expect(c.routerTimeoutMs).toBe(5000);
  });

  it('reads overrides from env', () => {
    const c = loadChatConfig({
      OPENAI_MODEL: 'd',
      OPENAI_ROUTER_MODEL: 'r',
      OPENAI_WEB_MODEL: 'w',
      OPENAI_ROUTER_EFFORT: 'LOW',
      OPENAI_WEB_EFFORT: 'medium',
      WEB_SEARCH_ENABLED: 'true',
    });
    expect(c).toMatchObject({ dataModel: 'd', routerModel: 'r', webModel: 'w', routerEffort: 'low', webEffort: 'medium', webSearchEnabled: true });
  });

  it('web search is on only for the exact string "true"; unknown efforts are ignored', () => {
    expect(loadChatConfig({ WEB_SEARCH_ENABLED: '1', OPENAI_WEB_MODEL: 'w' }).webSearchEnabled).toBe(false);
    expect(loadChatConfig({ WEB_SEARCH_ENABLED: 'TRUE', OPENAI_WEB_MODEL: 'w' }).webSearchEnabled).toBe(false);
    expect(loadChatConfig({ OPENAI_ROUTER_EFFORT: 'extreme' }).routerEffort).toBeUndefined();
  });

  it('web search stays off when WEB_SEARCH_ENABLED is true but OPENAI_WEB_MODEL is not set', () => {
    expect(loadChatConfig({ WEB_SEARCH_ENABLED: 'true' }).webSearchEnabled).toBe(false);
    expect(loadChatConfig({ WEB_SEARCH_ENABLED: 'true', OPENAI_WEB_MODEL: '' }).webSearchEnabled).toBe(false);
  });
});
