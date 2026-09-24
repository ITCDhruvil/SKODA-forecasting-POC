export interface ExportGoldenCase {
  id: string;
  message: string;
  /** True when the model should offer a download for this message. */
  expected: boolean;
  /** When an offer is expected, the format it should pick. */
  format?: 'xlsx' | 'docx';
}

export const EXPORT_GOLDEN_CASES: ExportGoldenCase[] = [
  // Should offer a spreadsheet: many rows, or an explicit "all"
  { id: 'xlsx-01', message: 'List every part with a forecast price increase', expected: true, format: 'xlsx' },
  { id: 'xlsx-02', message: 'Give me the top 30 rising parts', expected: true, format: 'xlsx' },
  { id: 'xlsx-03', message: 'Show me all parts from the Bosch vendor', expected: true, format: 'xlsx' },
  { id: 'xlsx-04', message: 'I need the full spend rollup by vendor for the review', expected: true, format: 'xlsx' },
  { id: 'xlsx-05', message: 'Can you send procurement the list of flagged parts?', expected: true, format: 'xlsx' },
  { id: 'xlsx-06', message: 'Pull every shock scenario with its price impact', expected: true, format: 'xlsx' },
  { id: 'xlsx-07', message: 'Break down spend by category so I can share it with the team', expected: true, format: 'xlsx' },

  // Should offer a document: reasoning a human will read
  { id: 'docx-01', message: 'Write up what the freight shock means for our exposure', expected: true, format: 'docx' },
  { id: 'docx-02', message: 'I need something I can take into the procurement meeting about FX risk', expected: true, format: 'docx' },
  { id: 'docx-03', message: 'Summarise the model accuracy story for my manager', expected: true, format: 'docx' },
  { id: 'docx-04', message: 'Explain the geopolitical risk picture as a short report', expected: true, format: 'docx' },

  // Should NOT offer: small or single-value answers
  { id: 'none-01', message: 'What is the basket price right now?', expected: false },
  { id: 'none-02', message: 'Which part is rising fastest?', expected: false },
  { id: 'none-03', message: 'How many categories are there?', expected: false },
  { id: 'none-04', message: 'Is the forecast model any good?', expected: false },
  { id: 'none-05', message: 'What does the Hierarchy Drill-down panel do?', expected: false },
  { id: 'none-06', message: 'Show me the top 3 movers', expected: false },
  { id: 'none-07', message: 'Where does the FX data come from?', expected: false },
  { id: 'none-08', message: 'Hi', expected: false },
  { id: 'none-09', message: 'What is the capital of France?', expected: false },
];
