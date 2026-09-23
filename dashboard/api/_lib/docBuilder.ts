// dashboard/api/_lib/docBuilder.ts
//
// Pure formatting: bytes in, bytes out. No model, no data access, no network.
// This module also owns the document model (ReportDoc); reportCompose.ts produces one.
import ExcelJS from 'exceljs';
import { Document, HeadingLevel, Packer, Paragraph, Table, TableCell, TableRow, TextRun, WidthType } from 'docx';
import type { ExportData } from './exportCatalog';

export const XLSX_CONTENT_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
export const DOCX_CONTENT_TYPE = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

export interface ReportSection {
  heading: string;
  paragraphs: string[];
}

export interface ReportDoc {
  title: string;
  sections: ReportSection[];
}

/** Server-derived, always. A client-supplied filename is never used. */
export function exportFilename(title: string, format: 'xlsx' | 'docx', now: Date = new Date()): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const stem = slug || 'export';
  const date = now.toISOString().slice(0, 10);
  return `${stem}-${date}.${format}`;
}

export async function buildXlsx(data: ExportData): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  workbook.created = new Date();
  const sheet = workbook.addWorksheet('Data');

  sheet.columns = data.columns.map((c) => ({ header: c.label, key: c.key, width: Math.max(12, c.label.length + 4) }));
  sheet.getRow(1).font = { bold: true };

  for (const row of data.rows) {
    sheet.addRow(data.columns.reduce<Record<string, unknown>>((acc, c) => {
      acc[c.key] = row[c.key] ?? null;
      return acc;
    }, {}));
  }

  if (data.truncated) {
    sheet.addRow({});
    sheet.addRow({ [data.columns[0].key]: `Truncated: only the first ${data.rows.length} rows are included.` });
  }

  sheet.addRow({});
  sheet.addRow({ [data.columns[0].key]: `Source: ${data.source}` });

  return Buffer.from(await workbook.xlsx.writeBuffer());
}

function tableFrom(data: ExportData): Table {
  const header = new TableRow({
    children: data.columns.map(
      (c) => new TableCell({ children: [new Paragraph({ children: [new TextRun({ text: c.label, bold: true })] })] }),
    ),
  });
  const body = data.rows.map(
    (row) =>
      new TableRow({
        children: data.columns.map(
          (c) => new TableCell({ children: [new Paragraph(String(row[c.key] ?? ''))] }),
        ),
      }),
  );
  return new Table({ rows: [header, ...body], width: { size: 100, type: WidthType.PERCENTAGE } });
}

export async function buildDocx(doc: ReportDoc, table: ExportData | null): Promise<Buffer> {
  const children: (Paragraph | Table)[] = [new Paragraph({ text: doc.title, heading: HeadingLevel.HEADING_1 })];

  for (const section of doc.sections) {
    children.push(new Paragraph({ text: section.heading, heading: HeadingLevel.HEADING_2 }));
    for (const text of section.paragraphs) children.push(new Paragraph(text));
  }

  if (table) {
    children.push(new Paragraph({ text: table.title, heading: HeadingLevel.HEADING_2 }));
    children.push(tableFrom(table));
    if (table.truncated) {
      children.push(new Paragraph(`Truncated: only the first ${table.rows.length} rows are included.`));
    }
    children.push(new Paragraph(`Source: ${table.source}`));
  }

  return Packer.toBuffer(new Document({ sections: [{ children }] }));
}
