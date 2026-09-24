//
// The chat-turn half of export. The handler returns a small acknowledgement to the model
// – which is what lets the model close its answer by mentioning the offer in its own words –
// and pushes the real ExportOffer out through onExport, exactly as showChart does with onChart.
import { callKey } from './callKey';
import { EXPORT_IDS, type ExportId } from './exportCatalog';
import type { ToolDefinition } from './tools';

export const MAX_EXPORTS_PER_ANSWER = 1;

export type ExportFormat = 'xlsx' | 'docx';

export interface ExportDataRef {
  export: ExportId;
  params: Record<string, string | number>;
}

export interface ExportOffer {
  /** The model's pick; the card shows this as the primary button and the other format as a link. */
  format: ExportFormat;
  label: string;
  /** Null for a pure narrative document. Required for xlsx. */
  dataRef: ExportDataRef | null;
}

const PARAM_KEYS = ['direction', 'n', 'level', 'family', 'query', 'category', 'vendor', 'project'] as const;

export function offerExportDefinition(): ToolDefinition {
  return {
    type: 'function',
    function: {
      name: 'offerExport',
      description:
        'Offer the user a downloadable file alongside your text answer, at most once per answer. ' +
        'Offer when the answer covers more than roughly ten rows, when the user asks for "all", "every" or "the full list", ' +
        'or when the message mentions sending, sharing, a report, a deck, their team, a meeting, procurement or sign-off. ' +
        'Do NOT offer for five rows or fewer, or for a single number – the user can read those in the chat. ' +
        'Pick format "xlsx" when the answer is rows, a ranking or many parts; "docx" when it is an explanation, a scenario ' +
        'or a recommendation; "xlsx" when it is clearly both. ' +
        'Set "export" to the catalog id whose rows back the answer: top_movers (needs direction) for rankings, ' +
        'parts_search for a filtered part list, category_breakdown or hierarchy (needs level) for spend rollups, ' +
        'alerts for procurement review items, scenarios (optional family) for shock scenarios. ' +
        'xlsx always needs an "export". docx may omit it for a pure write-up. ' +
        'After calling this, finish your answer by mentioning the file in your own words.',
      parameters: {
        type: 'object',
        properties: {
          format: { type: 'string', enum: ['xlsx', 'docx'] },
          label: { type: 'string', description: 'Short human name for the file, e.g. "Top 20 rising parts".' },
          export: { type: 'string', enum: [...EXPORT_IDS] },
          direction: { type: 'string', enum: ['up', 'down'], description: 'Required for top_movers.' },
          n: { type: 'number', description: 'top_movers only: how many parts, default 20.' },
          level: { type: 'string', enum: ['category', 'vendor', 'project'], description: 'Required for hierarchy.' },
          family: { type: 'string', enum: ['fx', 'freight', 'gpr', 'duty'], description: 'scenarios only: narrow to one family.' },
          query: { type: 'string', description: 'parts_search only: substring of a part id or name.' },
          category: { type: 'string', description: 'parts_search only.' },
          vendor: { type: 'string', description: 'parts_search only.' },
          project: { type: 'string', description: 'parts_search only.' },
        },
        required: ['format', 'label'],
      },
    },
  };
}

export function buildOfferExportHandler(onExport?: (offer: ExportOffer) => void): (args: any) => unknown {
  const seen = new Set<string>();
  let offered = 0;

  return (args: any) => {
    const format = args?.format;
    if (format !== 'xlsx' && format !== 'docx') {
      return { error: `unknown format "${String(format)}"; valid: xlsx, docx` };
    }

    const label = typeof args?.label === 'string' ? args.label.trim() : '';
    if (!label) return { error: 'label is required and must be a non-empty string' };

    const exportId = args?.export;
    if (exportId !== undefined && !(EXPORT_IDS as readonly string[]).includes(exportId)) {
      return { error: `unknown export "${String(exportId)}"; valid: ${EXPORT_IDS.join(', ')}` };
    }
    if (format === 'xlsx' && exportId === undefined) {
      return { error: 'xlsx needs an "export" id; use docx for a write-up with no table' };
    }

    const key = callKey(args ?? {});
    if (seen.has(key)) return { ok: true, note: 'already offered' };
    if (offered >= MAX_EXPORTS_PER_ANSWER) {
      return { error: `export limit reached (${MAX_EXPORTS_PER_ANSWER} per answer)` };
    }

    let dataRef: ExportDataRef | null = null;
    if (exportId !== undefined) {
      const params: Record<string, string | number> = {};
      for (const k of PARAM_KEYS) {
        const v = args[k];
        if (typeof v === 'string' || typeof v === 'number') params[k] = v;
      }
      dataRef = { export: exportId as ExportId, params };
    }

    seen.add(key);
    offered += 1;
    onExport?.({ format, label, dataRef });

    return { ok: true, offered: format, label };
  };
}
