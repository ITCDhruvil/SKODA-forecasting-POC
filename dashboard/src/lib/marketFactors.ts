/**
 * POC: the real-world factors that move auto-part prices, by category, used to make the "Why?"
 * answer read like a procurement analyst's commentary. Qualitative only: these are plausible
 * market reasons, NOT measured model inputs, and they carry no figures. The assistant is told to
 * label them as market context.
 */

const GENERAL: string[] = [
  'Currency: a weaker rupee vs USD/EUR raises imported content (chips, resins, tooling).',
  'Energy and crude: crude-linked feedstock, diesel and power tariffs feed resin, casting, forging and logistics costs with a quarter lag.',
  'Freight: container rates, Red Sea rerouting and port congestion raise landed cost.',
  'Supplier resets: quarterly or annual contract revisions pass earlier raw-material moves on in steps.',
  'Labour and overheads: wage settlements and plant costs pass on at the next revision.',
  'Demand and capacity: festive and launch volumes tighten supplier capacity and support prices.',
  'Policy: customs duty, GST and new safety or emission norms add cost.',
  'Geopolitics: conflicts and sanctions disrupt metals, chips and shipping.',
];

const BY_CATEGORY: Record<string, string[]> = {
  Lighting: [
    'Polycarbonate and ABS resin follow crude-linked benzene and BPA; moulders reprice within a quarter.',
    'LED modules depend on chip supply and imported-chip currency cost.',
    'Aluminium (reflectors) follows LME plus Indian power costs; copper wiring follows LME copper.',
  ],
  Electrical: [
    'Copper follows the LME benchmark and harness suppliers use index-linked clauses.',
    'PVC and nylon insulation follow the petrochemical cycle.',
    'Brass terminals follow copper and zinc; EV content tightens harness capacity.',
  ],
  Fasteners: [
    'Steel wire rod follows domestic mill rounds, iron-ore and coking-coal costs.',
    'Zinc plating and energy-heavy heat treatment add processing cost.',
    'Steel safeguard duties and import competition shape mill pricing.',
  ],
  'Interior Trim': [
    'Polypropylene and ABS follow the petrochemical cycle and are repriced within a quarter.',
    'Foam chemicals (polyol, TDI), textile, vinyl and adhesives follow crude and chemical utilisation.',
    'Model-refresh tooling and grain changes add one-off cost.',
  ],
  HVAC: [
    'Aluminium (condensers) follows LME plus power; copper tubing follows LME copper.',
    'Refrigerant shifts (for example R-1234yf) carry a premium.',
    'Blower motors and controllers use imported electronics, so currency and chips matter.',
  ],
  Braking: [
    'Cast iron follows pig iron, scrap and foundry power, which are firm.',
    'Friction material follows phenolic resin, steel fibre and copper-free formulations.',
    'Safety-critical parts carry strict testing, so supplier pass-through is rarely negotiated down.',
  ],
  'Body Stampings': [
    'Steel coil follows domestic mill rounds, iron-ore, coking coal and safeguard duty.',
    'Zinc for galvanising and e-coat chemicals add processed cost.',
    'Press-shop energy and scrap-offset terms change net steel cost.',
  ],
  Sensors: [
    'Semiconductors and sensor elements stay tight; imported chips tie cost to USD/EUR.',
    'PCBs, copper laminate and rare-earth magnets follow electronics and metals markets.',
    'Rising ADAS content raises demand and calibration effort.',
  ],
  Powertrain: [
    'Aluminium and alloy steel follow LME and mill prices; casting and forging are energy-heavy.',
    'Bearings, seals and fuel parts carry imported content, so currency and freight matter.',
    'Emission-norm changes (BS-VI) add components and validation cost.',
  ],
  Chassis: [
    'Steel plate, forged alloy and spring steel follow mill rounds and forging energy.',
    'Natural and synthetic rubber for bushings follow crop supply and crude.',
    'Heavy forging and welding capacity is tight at OEM volume peaks.',
  ],
};

export interface FactorContext {
  category: string;
  vendor: string;
  origin: string;
  project: string;
  /** Material names in this part's cost build-up. */
  materials: string[];
  direction: 'up' | 'down';
}

/** Lines for the Why? prompt: the market factors that could plausibly explain this move. */
export function marketFactorBrief(ctx: FactorContext): string[] {
  const specific = BY_CATEGORY[ctx.category] ?? [];
  const international = ctx.origin === 'international';
  const lines = [
    'MARKET FACTOR BRIEF (POC illustrative market context, not measured model inputs, no figures):',
    `Part context: ${ctx.category} part for ${ctx.project}, supplied by ${ctx.vendor}${international ? ' (international: currency and freight matter more)' : ' (domestic: local metal, resin and power costs matter more)'}.`,
    ctx.materials.length > 0 ? `Materials in its cost build-up: ${ctx.materials.join(', ')}.` : '',
    `Factors specific to ${ctx.category}:`,
    ...specific.map((f) => `  - ${f}`),
    'General factors that apply across auto parts:',
    ...GENERAL.map((f) => `  - ${f}`),
    ctx.direction === 'up'
      ? 'Forecast is a RISE: use factors that raise cost.'
      : 'Forecast is a FALL: use factors that ease cost (softer metal or resin, firmer rupee, lower freight, spare capacity).',
  ];
  return lines.filter(Boolean);
}
