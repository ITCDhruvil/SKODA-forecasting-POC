import { copyFileSync, mkdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DASHBOARD_ROOT = path.resolve(__dirname, '..');
const REPO_ROOT = path.resolve(DASHBOARD_ROOT, '..');
const DEST_DIR = path.join(DASHBOARD_ROOT, 'api', '_data');

const FILES = [
  {
    src: path.join(REPO_ROOT, 'data', 'processed', 'forecasts.csv'),
    dest: path.join(DEST_DIR, 'forecasts.csv'),
  },
  {
    src: path.join(REPO_ROOT, 'data', 'raw', 'parts_prices.csv'),
    dest: path.join(DEST_DIR, 'parts_prices.csv'),
  },
  {
    src: path.join(DASHBOARD_ROOT, 'public', 'dashboard.json'),
    dest: path.join(DEST_DIR, 'dashboard.json'),
  },
];

mkdirSync(DEST_DIR, { recursive: true });

for (const { src, dest } of FILES) {
  if (!existsSync(src)) {
    console.error(`[sync-part-data] missing source file: ${src}`);
    process.exit(1);
  }
  copyFileSync(src, dest);
  console.log(`[sync-part-data] copied ${path.basename(src)} -> ${dest}`);
}
