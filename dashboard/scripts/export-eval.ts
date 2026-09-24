// Usage: npm run eval:export
// Runs the golden set through a real data-mode answer and reports offer accuracy.
import 'dotenv/config';
import { EXPORT_GOLDEN_CASES } from '../api/_eval/exportGolden';
import { loadChatConfig } from '../api/_lib/config';
import { createOpenAIResponsesApi } from '../api/_lib/openaiApi';
import { answer } from '../api/_lib/orchestrator';

const apiKey = process.env.OPENAI_API_KEY;
if (!apiKey) {
  console.error('OPENAI_API_KEY is not set in dashboard/.env');
  process.exit(1);
}

const api = createOpenAIResponsesApi(apiKey);
const config = loadChatConfig();
const failures: string[] = [];
let correct = 0;

for (const c of EXPORT_GOLDEN_CASES) {
  const result = await answer(
    { messages: [{ role: 'user', content: c.message }], webEnabled: false, ip: 'eval' },
    { api, config, checkBudget: async () => ({ allowed: false }) },
  );
  const offered = result.exports.length > 0;
  const format = result.exports[0]?.format;

  const formatOk = !c.expected || !c.format || format === c.format;
  if (offered === c.expected && formatOk) {
    correct += 1;
  } else {
    failures.push(
      `   ${c.id}: expected ${c.expected ? `offer/${c.format ?? 'any'}` : 'no offer'}, got ${offered ? `offer/${format}` : 'no offer'}`,
    );
  }
}

const accuracy = correct / EXPORT_GOLDEN_CASES.length;
console.log(`${accuracy >= 0.85 ? 'PASS' : 'FAIL'} accuracy=${(accuracy * 100).toFixed(1)}% (${correct}/${EXPORT_GOLDEN_CASES.length})`);
for (const f of failures) console.log(f);
process.exit(accuracy >= 0.85 ? 0 : 1);
