/**
 * POC: plausible, buyer-friendly market reasons per material, used to make the "Why?" answer
 * read like real commentary. Illustrative narrative only; these are not measured inputs and
 * carry no figures.
 */
const MATERIAL_CONTEXT: Record<string, string> = {
  Polycarbonate:
    'Polycarbonate resin follows crude-linked feedstock (benzene and BPA) and converters have been passing on a price round; lighting lens and housing suppliers usually reprice with a one-quarter lag.',
  Aluminium:
    'Aluminium follows the LME price plus Indian smelter power and premium costs; die-casting suppliers normally reset their prices quarterly, so a rise in the metal reaches parts a few months later.',
  Copper:
    'Copper tracks the LME benchmark, and wiring and electrical suppliers often carry index-linked clauses, so a rise in the metal flows into part prices fairly directly.',
  Steel:
    'Steel follows domestic hot-rolled coil prices and mill contract resets; stamping and chassis suppliers usually pass these on at the next contract revision.',
  'Cast iron':
    'Cast iron follows pig iron and scrap prices, plus foundry energy costs, which have been firm.',
  Polymer:
    'Polymer grades such as PP and ABS move with the petrochemical cycle; moulders typically pass on resin changes within a quarter.',
  Silicon:
    'Silicon and semiconductor-grade inputs have seen tight supply, and electronics suppliers have been revising prices to cover it.',
};

export function materialMarketContext(material: string | undefined): string | null {
  if (!material) return null;
  return MATERIAL_CONTEXT[material] ?? null;
}
