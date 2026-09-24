// Usage: npm run eval:router -- --models gpt-a,gpt-b --efforts none,low
// Runs the golden set through the real router for every model x effort combination.
import 'dotenv/config';
import { GOLDEN_CASES } from '../api/_eval/routerGolden';
import { passes, runRouterEval } from '../api/_eval/routerEval';
import { createOpenAIResponsesApi } from '../api/_lib/openaiApi';
import type { ReasoningEffort } from '../api/_lib/responsesClient';
import { routeMessage, stubOf } from '../api/_lib/router';

const args = process.argv.slice(2);
function list(name: string): string[] {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1].split(',').map((s) => s.trim()).filter(Boolean) : [];
}

const apiKey = process.env.OPENAI_API_KEY;
if (!apiKey) {
  console.error('OPENAI_API_KEY is not set in dashboard/.env');
  process.exit(1);
}
const models = list('models');
if (models.length === 0) {
  console.error('Pass --models a,b,c');
  process.exit(1);
}
const efforts = list('efforts');
const api = createOpenAIResponsesApi(apiKey);

for (const model of models) {
  for (const effort of efforts.length ? efforts : ['none']) {
    const result = await runRouterEval(GOLDEN_CASES, (c) =>
      routeMessage(
        { api, model, timeoutMs: 15_000, reasoningEffort: effort === 'none' ? undefined : (effort as ReasoningEffort) },
        { lastUserMessage: c.message, lastReplyStub: stubOf(c.lastReply), webAllowed: true },
      ),
    );
    console.log(
      `${passes(result) ? 'PASS' : 'FAIL'} model=${model} effort=${effort} accuracy=${(result.accuracy * 100).toFixed(1)}% critical_failures=${result.criticalFailures} p50=${result.p50Ms}ms p95=${result.p95Ms}ms`,
    );
    for (const f of result.failures) console.log(`   ${f.id}: expected ${f.expected}, got ${f.got}`);
  }
}
