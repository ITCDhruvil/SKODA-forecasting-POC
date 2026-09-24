import dotenv from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRootEnv = path.resolve(here, '../../env');

// Prefer the shared repo `env` file; allow a local dashboard/.env to override.
dotenv.config({ path: repoRootEnv });
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
