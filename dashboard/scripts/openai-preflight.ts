// scripts/openai-preflight.ts
// Usage:
//   npx tsx scripts/openai-preflight.ts --list
//   npx tsx scripts/openai-preflight.ts --model <model-id> [--effort low]
import 'dotenv/config';
import OpenAI from 'openai';

const args = process.argv.slice(2);
function flag(name: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
}

const apiKey = process.env.OPENAI_API_KEY;
if (!apiKey) {
  console.error('OPENAI_API_KEY is not set in dashboard/.env');
  process.exit(1);
}

const client = new OpenAI({ apiKey, maxRetries: 0, timeout: 90_000 });

async function listModels(): Promise<void> {
  const ids: string[] = [];
  for await (const m of client.models.list()) ids.push(m.id);
  const usable = ids.filter((id) => /^(gpt|o\d)/.test(id)).sort();
  console.log(`Models visible to this key (${usable.length} gpt/o-series):`);
  for (const id of usable) console.log(`  ${id}`);
}

async function webSmoke(model: string, effort: string | undefined): Promise<void> {
  const started = Date.now();
  const body: Record<string, unknown> = {
    model,
    input: 'What is the latest news about steel tariffs affecting car makers? Answer in two sentences and cite sources.',
    tools: [{ type: 'web_search', filters: { allowed_domains: ['reuters.com', 'ft.com', 'autonews.com'] } }],
    max_tool_calls: 2,
  };
  if (effort) body.reasoning = { effort };
  try {
    const res: any = await client.responses.create(body as any);
    const items: any[] = res.output ?? [];
    const searches = items.filter((i) => i.type === 'web_search_call').length;
    const cited: string[] = [];
    let text = '';
    for (const item of items) {
      if (item.type !== 'message') continue;
      for (const part of item.content ?? []) {
        if (part.type !== 'output_text') continue;
        text += part.text;
        for (const a of part.annotations ?? []) if (a.type === 'url_citation') cited.push(new URL(a.url).hostname);
      }
    }
    const pass = searches >= 1;
    console.log(`${pass ? 'PASS' : 'FAIL'} model=${model} effort=${effort ?? '-'} ${Date.now() - started}ms status=${res.status} searches=${searches} citedHosts=${[...new Set(cited)].join(',') || '-'}`);
    console.log(`  reply: ${text.slice(0, 240).replace(/\s+/g, ' ')}`);
  } catch (err: any) {
    console.log(`FAIL model=${model} effort=${effort ?? '-'} ${Date.now() - started}ms error=${err?.status ?? ''} ${err?.message ?? err}`);
  }
}

if (args.includes('--list')) await listModels();
const model = flag('model');
if (model) await webSmoke(model, flag('effort'));
if (!args.includes('--list') && !model) console.error('Pass --list and/or --model <id>');
