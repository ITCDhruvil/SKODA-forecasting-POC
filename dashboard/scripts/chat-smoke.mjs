// Usage: node scripts/chat-smoke.mjs [--no-web] [--url http://localhost:3001/api/chat] ["question" ...]
// Needs the dev API running (npm run dev). Prints status, latency, mode, sources and a reply preview.
const DEFAULT_QUESTIONS = [
  'Which parts are seeing the biggest price increases?',
  "What's our spend at risk this quarter?",
  'Are there any geopolitical risks I need to review?',
  'How accurate is the forecasting model?',
  'How do I see the FX impact scenarios?',
  "What's the capital of France?",
];

const argv = process.argv.slice(2);
let webEnabled = true;
let url = 'http://localhost:3001/api/chat';
const questions = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--no-web') webEnabled = false;
  else if (a === '--url') url = argv[++i];
  else questions.push(a);
}

for (const q of questions.length ? questions : DEFAULT_QUESTIONS) {
  const started = Date.now();
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ messages: [{ role: 'user', content: q }], webEnabled }),
  });
  const payload = await res.json().catch(() => ({}));
  console.log(`\n=== ${q}`);
  console.log(
    `[${res.status}] ${Date.now() - started}ms mode=${payload.mode ?? '-'} usedWeb=${payload.usedWeb ?? '-'} sources=${payload.sources?.length ?? 0}`,
  );
  console.log((payload.reply ?? payload.error ?? '').slice(0, 1200));
  for (const s of payload.sources ?? []) console.log(`  - ${s.domain}: ${s.title} (${s.url})`);
}
