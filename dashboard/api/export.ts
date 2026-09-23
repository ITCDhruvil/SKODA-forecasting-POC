import type { VercelRequest, VercelResponse } from '@vercel/node';
import { loadChatConfig } from './_lib/config';
import {
  buildDocx,
  buildXlsx,
  DOCX_CONTENT_TYPE,
  exportFilename,
  XLSX_CONTENT_TYPE,
} from './_lib/docBuilder';
import { buildExportData, EXPORT_IDS, type BuildExportArgs, type ExportData } from './_lib/exportCatalog';
import type { ExportOffer } from './_lib/exportOffer';
import { createOpenAIResponsesApi } from './_lib/openaiApi';
import type { IncomingMessage } from './_lib/orchestrator';
import { checkRateLimit } from './_lib/rateLimit';
import { composeReport } from './_lib/reportCompose';

const MAX_MESSAGES = 30;
const MAX_MESSAGE_LENGTH = 4000;

interface ExportBody {
  offer: ExportOffer;
  format: 'xlsx' | 'docx';
  messages?: IncomingMessage[];
}

function isMessage(m: unknown): m is IncomingMessage {
  if (!m || typeof m !== 'object') return false;
  const o = m as Record<string, unknown>;
  return (o.role === 'user' || o.role === 'assistant') && typeof o.content === 'string';
}

/** Validates the untrusted request body. The client's export id is a string and nothing more. */
export function isValidExportBody(raw: unknown): raw is ExportBody {
  if (!raw || typeof raw !== 'object') return false;
  const b = raw as Record<string, unknown>;

  if (b.format !== 'xlsx' && b.format !== 'docx') return false;
  if (!b.offer || typeof b.offer !== 'object') return false;

  const offer = b.offer as Record<string, unknown>;
  if (offer.format !== 'xlsx' && offer.format !== 'docx') return false;
  if (typeof offer.label !== 'string' || !offer.label.trim()) return false;

  const ref = offer.dataRef;
  if (ref !== null) {
    if (!ref || typeof ref !== 'object') return false;
    const r = ref as Record<string, unknown>;
    if (typeof r.export !== 'string' || !(EXPORT_IDS as readonly string[]).includes(r.export)) return false;
    if (!r.params || typeof r.params !== 'object' || Array.isArray(r.params)) return false;
  }

  // A spreadsheet of nothing is an error, not an empty file.
  if (b.format === 'xlsx' && ref === null) return false;

  if (b.format === 'docx') {
    if (!Array.isArray(b.messages) || b.messages.length === 0) return false;
    if (!b.messages.every(isMessage)) return false;
    if (b.messages.length > MAX_MESSAGES) return false;
    if (b.messages.some((m) => (m as IncomingMessage).content.length > MAX_MESSAGE_LENGTH)) return false;
  }

  return true;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'method not allowed' });
    return;
  }

  const forwardedFor = req.headers['x-forwarded-for'];
  const ip =
    (Array.isArray(forwardedFor) ? forwardedFor[0] : forwardedFor)?.split(',')[0]?.trim() ||
    req.socket.remoteAddress ||
    'unknown';

  if (!checkRateLimit(ip).allowed) {
    res.status(429).json({ error: 'too many requests, try again in a few minutes' });
    return;
  }

  if (!isValidExportBody(req.body)) {
    res.status(400).json({ error: 'invalid request body' });
    return;
  }

  const body = req.body as ExportBody;
  const { offer, format } = body;

  let table: ExportData | null = null;
  if (offer.dataRef) {
    const built = buildExportData({ export: offer.dataRef.export, ...offer.dataRef.params } as BuildExportArgs);
    if ('error' in built) {
      res.status(400).json({ error: built.error });
      return;
    }
    table = built;
  }

  try {
    if (format === 'xlsx') {
      const buffer = await buildXlsx(table as ExportData);
      // Filenames are always derived server-side; a client-supplied filename is ignored.
      const filename = exportFilename((table as ExportData).title, 'xlsx');
      res.status(200);
      res.setHeader('Content-Type', XLSX_CONTENT_TYPE);
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      res.setHeader('Cache-Control', 'no-store');
      res.send(buffer);
      return;
    }

    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      res.status(502).json({ error: 'export temporarily unavailable' });
      return;
    }
    const config = loadChatConfig();
    const doc = await composeReport(
      { api: createOpenAIResponsesApi(apiKey), model: config.dataModel, timeoutMs: config.dataTimeoutMs },
      { messages: body.messages ?? [], label: offer.label },
    );
    const buffer = await buildDocx(doc, table);
    const filename = exportFilename(doc.title || offer.label, 'docx');
    res.status(200);
    res.setHeader('Content-Type', DOCX_CONTENT_TYPE);
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Cache-Control', 'no-store');
    res.send(buffer);
  } catch (err) {
    console.error('export endpoint error', err);
    res.status(502).json({ error: 'export temporarily unavailable' });
  }
}
