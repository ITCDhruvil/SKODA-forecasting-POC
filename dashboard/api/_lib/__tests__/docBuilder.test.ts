// dashboard/api/_lib/__tests__/docBuilder.test.ts
import { describe, it, expect } from 'vitest';
import ExcelJS from 'exceljs';
import { buildDocx, buildXlsx, exportFilename, type ReportDoc } from '../docBuilder';
import type { ExportData } from '../exportCatalog';

const DATA: ExportData = {
  title: 'Top 3 rising parts',
  columns: [
    { key: 'partId', label: 'Part ID' },
    { key: 'changePct', label: 'Change %' },
  ],
  rows: [
    { partId: 'P-1', changePct: 12.5 },
    { partId: 'P-2', changePct: 9 },
    { partId: 'P-3', changePct: null },
  ],
  source: 'dashboard.json part index',
  truncated: false,
};

const DOC: ReportDoc = {
  title: 'Freight shock impact',
  sections: [
    { heading: 'What the model shows', paragraphs: ['Freight costs rise 20%.', 'Basket price moves 3.1%.'] },
    { heading: 'What to do', paragraphs: ['Review the three flagged vendors.'] },
  ],
};

// exceljs ships `declare interface Buffer extends ArrayBuffer {}` (node_modules/exceljs/index.d.ts:1),
// a legacy global shim that shadows Node's generic Buffer<ArrayBufferLike> at load()'s parameter
// position under @types/node 24. The cast is confined to this test helper; docBuilder.ts itself
// typechecks clean, and the workbook is still genuinely parsed at runtime.
async function loadWorkbook(buffer: Buffer): Promise<ExcelJS.Workbook> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer as unknown as ArrayBuffer);
  return wb;
}

describe('exportFilename', () => {
  it('slugs the title and stamps the date', () => {
    const name = exportFilename('Top 20 rising parts', 'xlsx', new Date('2026-09-23T10:00:00Z'));
    expect(name).toBe('top-20-rising-parts-2026-09-23.xlsx');
  });

  it('strips characters outside a-z 0-9 and dash', () => {
    const name = exportFilename('FX / "shock" scenarios (2026)', 'docx', new Date('2026-09-23T10:00:00Z'));
    expect(name).toBe('fx-shock-scenarios-2026-2026-09-23.docx');
  });

  it('falls back to a generic stem when the title slugs to nothing', () => {
    const name = exportFilename('!!!', 'xlsx', new Date('2026-09-23T10:00:00Z'));
    expect(name).toBe('export-2026-09-23.xlsx');
  });
});

describe('buildXlsx', () => {
  it('writes a parseable workbook with a header row and one row per record', async () => {
    const buffer = await buildXlsx(DATA);
    expect(buffer.length).toBeGreaterThan(0);

    const wb = await loadWorkbook(buffer);
    const sheet = wb.worksheets[0];
    expect(sheet.name).toBe('Data');

    const header = sheet.getRow(1).values as unknown[];
    expect(header[1]).toBe('Part ID');
    expect(header[2]).toBe('Change %');

    expect(sheet.getRow(2).getCell(1).value).toBe('P-1');
    expect(sheet.getRow(2).getCell(2).value).toBe(12.5);
    expect(sheet.getRow(4).getCell(2).value).toBeNull();
  });

  it('appends a source line below the data', async () => {
    const wb = await loadWorkbook(await buildXlsx(DATA));
    const sheet = wb.worksheets[0];
    const firstColumn: string[] = [];
    sheet.eachRow((row) => firstColumn.push(String(row.getCell(1).value ?? '')));
    // Scanned rather than pinned to a row number: ExcelJS does not count a blank addRow({}) consistently.
    expect(firstColumn.some((t) => t.startsWith('Source: dashboard.json part index'))).toBe(true);
    expect(firstColumn.indexOf('P-3')).toBeLessThan(firstColumn.findIndex((t) => t.startsWith('Source:')));
  });

  it('adds a truncation note when the data was capped', async () => {
    const wb = await loadWorkbook(await buildXlsx({ ...DATA, truncated: true }));
    const sheet = wb.worksheets[0];
    const texts: string[] = [];
    sheet.eachRow((row) => texts.push(String(row.getCell(1).value ?? '')));
    expect(texts.some((t) => t.toLowerCase().includes('truncated'))).toBe(true);
  });
});

describe('buildDocx', () => {
  it('produces a non-empty zip-shaped buffer with no table', async () => {
    const buffer = await buildDocx(DOC, null);
    expect(buffer.length).toBeGreaterThan(0);
    expect(buffer.subarray(0, 2).toString('latin1')).toBe('PK');
  });

  it('produces a larger document when a table is attached', async () => {
    const withoutTable = await buildDocx(DOC, null);
    const withTable = await buildDocx(DOC, DATA);
    expect(withTable.length).toBeGreaterThan(withoutTable.length);
  });

  it('tolerates a document with no sections', async () => {
    const buffer = await buildDocx({ title: 'Empty', sections: [] }, null);
    expect(buffer.length).toBeGreaterThan(0);
  });
});
