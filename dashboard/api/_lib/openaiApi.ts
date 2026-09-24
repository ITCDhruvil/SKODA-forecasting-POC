import OpenAI from 'openai';
import type { ResponseLike, ResponsesApi } from './responsesClient';

/**
 * Wraps the SDK behind our minimal ResponsesApi. Retries are off on purpose: with the SDK
 * default of 2 retries a single timed-out call could stack past the function's maxDuration.
 */
export function createOpenAIResponsesApi(apiKey: string): ResponsesApi {
  const openai = new OpenAI({ apiKey, maxRetries: 0 });
  return {
    create: async (body, options) => {
      // Boundary cast: SDK request types lag new API fields (e.g. web_search filters).
      const response = await openai.responses.create(body as never, options);
      return response as unknown as ResponseLike;
    },
  };
}
