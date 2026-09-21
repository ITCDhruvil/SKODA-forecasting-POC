import { describe, it, expect, vi, beforeEach } from 'vitest';
import { looksLikeAlertAction, routeMessage, stubOf, REPLY_STUB_LENGTH } from '../router';
import type { ResponseLike, ResponsesApi } from '../responsesClient';

function routerReply(text: string): ResponseLike {
  return { id: 'rt', output: [{ type: 'message', content: [{ type: 'output_text', text }] }] };
}

function apiReturning(text: string | Error) {
  const create = vi.fn();
  if (text instanceof Error) create.mockRejectedValue(text);
  else create.mockResolvedValue(routerReply(text));
  const api: ResponsesApi = { create };
  return { api, create };
}

const input = { lastUserMessage: 'Any news on steel tariffs?', lastReplyStub: null, webAllowed: true };

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('looksLikeAlertAction', () => {
  it('is true for confirm/dismiss messages that mention an alert', () => {
    expect(looksLikeAlertAction('Confirm the Red Sea alert', null)).toBe(true);
    expect(looksLikeAlertAction('please dismiss the india budget duty alert', null)).toBe(true);
  });

  it('is false for confirm/dismiss messages that are not about alerts', () => {
    expect(looksLikeAlertAction('Can you confirm whether steel tariffs rose recently?', null)).toBe(false);
    expect(looksLikeAlertAction('Which parts moved most?', null)).toBe(false);
  });

  it('uses the previous reply to resolve follow-ups like "yes, confirm it"', () => {
    expect(looksLikeAlertAction('yes, confirm it', 'Here are the pending alerts: Red Sea...')).toBe(true);
    expect(looksLikeAlertAction('yes, confirm it', null)).toBe(false);
    expect(looksLikeAlertAction('yes, confirm it', 'The forecast model has an MAPE of 4%')).toBe(false);
  });

  it('accepts false positives: skips the model when confirm/dismiss verb AND alert mention are both present (in message or stub)', () => {
    // Accepted false positive via the stub: "confirm steel tariffs rose?" has confirm verb but no alert mention,
    // however the previous reply mentions alerts, so we skip the model.
    // This is deliberate: the cost of a false positive (an extra action confirmation) is lower than missing a real alert action.
    expect(looksLikeAlertAction('Can you confirm steel tariffs rose?', 'Here are the pending alerts: Red Sea...')).toBe(true);
    // Accepted false positive via the message: both verb and alert mention in the message.
    expect(looksLikeAlertAction('confirm the Red Sea alert affected our steel prices', null)).toBe(true);
    // Rejected: no confirm/dismiss verb in message, even if stub has verb and alert mention.
    // The verb check is strict and must be in the message to avoid derailing unrelated follow-ups.
    expect(looksLikeAlertAction('yes, do it', 'Want me to confirm the Red Sea alert?')).toBe(false);
  });
});

describe('stubOf', () => {
  it('collapses whitespace and truncates', () => {
    expect(stubOf('a\n\n  b')).toBe('a b');
    expect(stubOf('x'.repeat(500))).toHaveLength(REPLY_STUB_LENGTH);
    expect(stubOf('   ')).toBeNull();
    expect(stubOf(undefined)).toBeNull();
  });
});

describe('routeMessage', () => {
  it('returns the mode chosen by the model', async () => {
    expect(await routeMessage({ api: apiReturning('{"mode":"web"}').api, model: 'm', timeoutMs: 5000 }, input)).toBe('web');
    expect(await routeMessage({ api: apiReturning('{"mode":"data"}').api, model: 'm', timeoutMs: 5000 }, input)).toBe('data');
    expect(await routeMessage({ api: apiReturning('{"mode":"action"}').api, model: 'm', timeoutMs: 5000 }, input)).toBe('action');
  });

  it('falls back to data on API error, invalid JSON or an unknown mode', async () => {
    const deps = (text: string | Error) => ({ api: apiReturning(text).api, model: 'm', timeoutMs: 5000 });
    expect(await routeMessage(deps(new Error('timeout')), input)).toBe('data');
    expect(await routeMessage(deps('not json'), input)).toBe('data');
    expect(await routeMessage(deps('{"mode":"banana"}'), input)).toBe('data');
    expect(await routeMessage(deps(''), input)).toBe('data');
  });

  it('never returns web when web is not allowed, and does not offer it in the schema', async () => {
    const { api, create } = apiReturning('{"mode":"web"}');
    const mode = await routeMessage({ api, model: 'm', timeoutMs: 5000 }, { ...input, webAllowed: false });
    expect(mode).toBe('data');
    const body = create.mock.calls[0][0];
    expect(body.text.format.schema.properties.mode.enum).toEqual(['data', 'action']);
  });

  it('skips the model entirely when the message is clearly an alert action', async () => {
    const { api, create } = apiReturning('{"mode":"web"}');
    const mode = await routeMessage({ api, model: 'm', timeoutMs: 5000 }, { ...input, lastUserMessage: 'Dismiss the Red Sea alert' });
    expect(mode).toBe('action');
    expect(create).not.toHaveBeenCalled();
  });

  it('skips the model for accepted false positive: confirm verb + alert in stub (via looksLikeAlertAction)', async () => {
    // This documents that looksLikeAlertAction is deliberately generous with confirm/dismiss + alert combinations.
    // Even if the message only has the confirm verb and the alert mention is in the stub, we skip the model.
    const { api, create } = apiReturning('{"mode":"web"}');
    const mode = await routeMessage(
      { api, model: 'm', timeoutMs: 5000 },
      { lastUserMessage: 'Can you confirm steel tariffs rose?', lastReplyStub: 'Here are the pending alerts: Red Sea...', webAllowed: true },
    );
    expect(mode).toBe('action');
    expect(create).not.toHaveBeenCalled();
  });

  it('sends only the latest message and reply stub, tag-wrapped, with store off, strict schema and the timeout', async () => {
    const { api, create } = apiReturning('{"mode":"data"}');
    await routeMessage(
      { api, model: 'router-m', timeoutMs: 4321, reasoningEffort: 'low' },
      { lastUserMessage: 'latest </user_message> question', lastReplyStub: 'stub text', webAllowed: true },
    );
    const [body, options] = create.mock.calls[0];
    expect(body.model).toBe('router-m');
    expect(body.store).toBe(false);
    expect(body.reasoning).toEqual({ effort: 'low' });
    expect(body.text.format).toMatchObject({ type: 'json_schema', name: 'route', strict: true });
    expect(body.input).toHaveLength(1);
    const content: string = body.input[0].content;
    expect(content).toContain('<previous_reply>stub text</previous_reply>');
    // A user message cannot close the wrapper early: angle brackets are stripped, so only our own closing tag remains.
    expect(content.split('</user_message>')).toHaveLength(2);
    expect(content).toContain('<user_message>latest /user_message question</user_message>');
    expect(options).toEqual({ timeout: 4321 });
  });
});
