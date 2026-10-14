import dotenv from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../..');

// The repo key file is `.env`. An undotted `env` file is also accepted.
// A local dashboard/.env overrides either one.
dotenv.config({ path: path.join(repoRoot, '.env') });
dotenv.config({ path: path.join(repoRoot, 'env') });
dotenv.config();

if (!process.env.OPENAI_API_KEY && process.env.AZURE_OPENAI_API_KEY) {
  process.env.OPENAI_API_KEY = process.env.AZURE_OPENAI_API_KEY;
}
if (!process.env.OPENAI_MODEL && process.env.AZURE_OPENAI_CHAT_DEPLOYMENT) {
  process.env.OPENAI_MODEL = process.env.AZURE_OPENAI_CHAT_DEPLOYMENT;
}
if (!process.env.OPENAI_ROUTER_MODEL && process.env.AZURE_OPENAI_FAST_DEPLOYMENT) {
  process.env.OPENAI_ROUTER_MODEL = process.env.AZURE_OPENAI_FAST_DEPLOYMENT;
}
