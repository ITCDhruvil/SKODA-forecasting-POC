import OpenAI from 'openai';
import type { ResponseLike, ResponsesApi } from './responsesClient';

/**
 * Wraps the SDK behind our minimal ResponsesApi. Retries are off on purpose: with the SDK
 * default of 2 retries a single timed-out call could stack past the function's maxDuration.
 *
 * When AZURE_OPENAI_ENDPOINT is set (local `env` file), talks to Azure OpenAI's v1 surface
 * and uses deployment names as model ids. Otherwise uses public OpenAI with OPENAI_API_KEY.
 */
export function createOpenAIResponsesApi(apiKey: string): ResponsesApi {
  const azureEndpoint = process.env.AZURE_OPENAI_ENDPOINT?.replace(/\/$/, '');
  const openai = azureEndpoint
    ? new OpenAI({
        apiKey,
        baseURL: `${azureEndpoint}/openai/v1/`,
        maxRetries: 0,
      })
    : new OpenAI({ apiKey, maxRetries: 0 });
  return {
    create: async (body, options) => {
      // Boundary cast: SDK request types lag new API fields (e.g. web_search filters).
      const response = await openai.responses.create(body as never, options);
      return response as unknown as ResponseLike;
    },
  };
}
