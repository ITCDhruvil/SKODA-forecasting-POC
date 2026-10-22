/**
 * POC display layer: replaces catalogue-style part names ("Electrical A18 - SKODA Slavia
 * (Minda Industries)") with plain names a buyer recognises, and shows a realistic unit price
 * in rupees. Purely presentational — part ids and forecast data are untouched.
 */

const PART_NAMES: Record<string, string[]> = {
  Electrical: ['Wiring Harness', 'Alternator', 'Starter Motor', 'Battery Terminal Set', 'Fuse Box', 'Ignition Coil', 'Relay Module', 'Horn Assembly', 'Wiper Motor', 'Power Window Motor'],
  Lighting: ['Headlamp Assembly', 'Tail Lamp Assembly', 'Fog Lamp', 'DRL Light Strip', 'Indicator Lamp', 'Brake Light Unit', 'Interior Dome Lamp', 'Number Plate Lamp'],
  Fasteners: ['Wheel Nut', 'Engine Mounting Bolt', 'Body Clip Set', 'Door Hinge Screw', 'Rivet Pack', 'Washer Kit', 'Panel Retainer Clip', 'Exhaust Stud'],
  'Interior Trim': ['Dashboard Panel', 'Door Trim Panel', 'Seat Fabric Cover', 'Centre Console', 'Headliner', 'Gear Knob Cover', 'Floor Carpet Set', 'Glove Box Assembly'],
  HVAC: ['AC Compressor', 'Condenser Unit', 'Blower Motor', 'Evaporator Core', 'Cabin Air Filter', 'Heater Core', 'AC Control Panel', 'Expansion Valve'],
  Braking: ['Front Brake Pad Set', 'Brake Disc', 'Brake Caliper', 'Master Cylinder', 'Brake Hose', 'Rear Brake Shoe Set', 'ABS Pump Unit', 'Handbrake Cable'],
  'Body Stampings': ['Front Door Panel', 'Bonnet Panel', 'Roof Panel', 'Boot Lid', 'Front Fender', 'Quarter Panel', 'Floor Pan', 'A-Pillar Reinforcement'],
  Sensors: ['Oxygen Sensor', 'Crankshaft Position Sensor', 'Parking Sensor', 'Wheel Speed Sensor', 'Coolant Temperature Sensor', 'Tyre Pressure Sensor', 'MAP Sensor', 'Rain Sensor'],
  Powertrain: ['Clutch Plate Set', 'Fuel Injector', 'Turbocharger', 'Timing Chain Kit', 'Gearbox Housing', 'Engine Oil Pump', 'Flywheel', 'Drive Shaft'],
  Chassis: ['Front Shock Absorber', 'Control Arm', 'Stabiliser Bar', 'Steering Rack', 'Wheel Hub Bearing', 'Rear Axle Beam', 'Coil Spring', 'Tie Rod End'],
};

/** Realistic per-unit price range (INR) per category. */
const PRICE_RANGE: Record<string, [number, number]> = {
  Electrical: [350, 4500],
  Lighting: [600, 6500],
  Fasteners: [8, 140],
  'Interior Trim': [800, 9000],
  HVAC: [1500, 12000],
  Braking: [700, 6500],
  'Body Stampings': [900, 8500],
  Sensors: [400, 5500],
  Powertrain: [2500, 35000],
  Chassis: [1200, 14000],
};

function hash(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** `seedId` is the first part of the group and `slot` the part's position, so siblings never repeat. */
export function friendlyPartName(category: string, seedId: string, slot: number, fallback: string): string {
  const names = PART_NAMES[category];
  if (!names) return fallback.replace(/\s+[A-Z]\d+\b/, '').replace(/\s+-\s+.*$/, '');
  return names[(hash(seedId) + slot) % names.length];
}

/** Stable, realistic unit price for a part, rounded to a sensible step. */
export function realisticPrice(category: string, partId: string): number | null {
  const range = PRICE_RANGE[category];
  if (!range) return null;
  const [lo, hi] = range;
  // Skew towards the cheaper half so a category does not look uniformly expensive.
  const t = Math.pow((hash(`${partId}:price`) % 10000) / 10000, 1.6);
  const raw = lo + (hi - lo) * t;
  const step = raw < 100 ? 1 : raw < 1000 ? 5 : 10;
  return Math.max(lo, Math.round(raw / step) * step);
}

/* ------------------------------------------------------------------------------------------
 * SAMPLE DATA — illustrative bill of materials for the POC tree.
 * Unit prices, quantities and splits below are made-up round numbers, NOT real market prices
 * and NOT from the forecasting model. Generated deterministically from the part id (seeded
 * RNG), so a part always gets the same materials. Every row carries `isSample: true`.
 * ---------------------------------------------------------------------------------------- */

/** [name, unit, sample unit price in INR (kg only), cost share weight, always included] */
type BomItem = [string, 'kg' | 'pc' | 'set' | 'job', number, number, boolean?];

const BOM: Record<string, BomItem[]> = {
  Lighting: [
    ['', 'kg', 260, 0.16, true], ['ABS housing', 'kg', 190, 0.14], ['Aluminium reflector', 'kg', 330, 0.1],
    ['LED module / bulb', 'pc', 0, 0.22, true], ['Copper wiring & connector', 'kg', 820, 0.09],
    ['Rubber gasket & seals', 'pc', 0, 0.04], ['Fasteners & clips', 'set', 0, 0.03],
    ['Assembly & testing', 'job', 0, 0.12, true], ['Packing', 'job', 0, 0.03],
  ],
  Electrical: [
    ['', 'kg', 820, 0.24, true], ['PVC insulation', 'kg', 140, 0.08], ['Brass terminals', 'kg', 560, 0.1],
    ['Nylon connector housing', 'kg', 290, 0.08], ['Fuse / relay unit', 'pc', 0, 0.14],
    ['Rubber grommets', 'pc', 0, 0.04], ['Steel fasteners', 'set', 0, 0.04],
    ['Assembly & testing', 'job', 0, 0.12, true], ['Packing', 'job', 0, 0.03],
  ],
  Fasteners: [
    ['', 'kg', 72, 0.4, true], ['Zinc plating', 'kg', 260, 0.08], ['Nylon washers', 'kg', 240, 0.05],
    ['Thread-lock coating', 'kg', 900, 0.04], ['Heat treatment', 'job', 0, 0.15, true],
    ['Inspection', 'job', 0, 0.08], ['Packing', 'job', 0, 0.05],
  ],
  'Interior Trim': [
    ['', 'kg', 115, 0.22, true], ['Fabric / vinyl skin', 'kg', 380, 0.16], ['Foam padding', 'kg', 210, 0.1],
    ['ABS substrate', 'kg', 190, 0.12], ['Adhesive', 'kg', 520, 0.05], ['Clips & fasteners', 'set', 0, 0.04],
    ['Assembly', 'job', 0, 0.14, true], ['Packing', 'job', 0, 0.03],
  ],
  HVAC: [
    ['', 'kg', 260, 0.22, true], ['Copper tubing', 'kg', 820, 0.14], ['Rubber seals', 'pc', 0, 0.05],
    ['Blower motor', 'pc', 0, 0.18, true], ['Steel brackets', 'kg', 72, 0.07],
    ['Electronic controller', 'pc', 0, 0.1], ['Assembly & testing', 'job', 0, 0.12, true], ['Packing', 'job', 0, 0.03],
  ],
  Braking: [
    ['', 'kg', 78, 0.26, true], ['Friction material', 'kg', 340, 0.16, true], ['Steel backing plate', 'kg', 72, 0.12],
    ['Rubber seals', 'pc', 0, 0.05], ['Shims & hardware', 'set', 0, 0.05], ['Anti-corrosion coating', 'kg', 600, 0.04],
    ['Machining', 'job', 0, 0.16], ['Testing', 'job', 0, 0.08, true], ['Packing', 'job', 0, 0.03],
  ],
  'Body Stampings': [
    ['', 'kg', 72, 0.45, true], ['Zinc coating', 'kg', 260, 0.06], ['Weld consumables', 'kg', 350, 0.05],
    ['Sealant', 'kg', 480, 0.04], ['Stamping', 'job', 0, 0.18, true], ['E-coat / painting', 'job', 0, 0.14, true],
    ['Packing', 'job', 0, 0.03],
  ],
  Sensors: [
    ['', 'pc', 0, 0.22, true], ['PCB board', 'pc', 0, 0.12], ['Copper wiring', 'kg', 820, 0.08],
    ['Plastic housing', 'kg', 240, 0.1], ['Epoxy potting', 'kg', 640, 0.05], ['Connector', 'pc', 0, 0.08],
    ['Calibration & testing', 'job', 0, 0.2, true], ['Assembly', 'job', 0, 0.12, true], ['Packing', 'job', 0, 0.03],
  ],
  Powertrain: [
    ['', 'kg', 260, 0.24, true], ['Alloy steel', 'kg', 110, 0.2, true], ['Bearings', 'pc', 0, 0.1],
    ['Seals & gaskets', 'pc', 0, 0.06], ['Lubricant', 'kg', 480, 0.03], ['Machining', 'job', 0, 0.18],
    ['Heat treatment', 'job', 0, 0.08], ['Assembly & testing', 'job', 0, 0.09, true], ['Packing', 'job', 0, 0.02],
  ],
  Chassis: [
    ['', 'kg', 72, 0.36, true], ['Rubber bushings', 'pc', 0, 0.08], ['Forged alloy steel', 'kg', 110, 0.14],
    ['Spring steel', 'kg', 95, 0.08], ['Powder coating', 'job', 0, 0.06], ['Fasteners', 'set', 0, 0.05],
    ['Welding & machining', 'job', 0, 0.14, true], ['Assembly & testing', 'job', 0, 0.07, true], ['Packing', 'job', 0, 0.02],
  ],
};

/** Small seeded RNG (mulberry32) so the same part id always yields the same materials. */
function seededRandom(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface SampleMaterial {
  name: string;
  unit: string;
  quantity: number;
  /** FC unit price in INR. SAMPLE value. */
  unitPrice: number;
  /** Cost per part at budget (BG), INR. */
  bg: number;
  /** Cost per part at forecast (FC), INR. */
  fc: number;
  /** True for the part's original pipeline material (keeps its bridges). */
  primary: boolean;
  isSample: true;
}

/**
 * Splits a part's budget and forecast price into 5-8 material lines. The forecast lines sum
 * exactly to `fcTotal` (so they sit inside the part's Interval) and the budget lines to `bgTotal`.
 */
export function sampleMaterials(
  category: string,
  partId: string,
  primaryName: string,
  bgTotal: number,
  fcTotal: number,
): SampleMaterial[] | null {
  const bom = BOM[category];
  if (!bom || bgTotal <= 0 || fcTotal <= 0) return null;
  const rand = seededRandom(hash(`${partId}:bom`));

  const target = 5 + Math.floor(rand() * 4); // 5..8 lines
  const picked = bom.filter((b) => b[4]);
  const optional = bom.filter((b) => !b[4]).map((b) => ({ b, r: rand() })).sort((x, y) => x.r - y.r);
  for (const { b } of optional) if (picked.length < Math.min(target, bom.length)) picked.push(b);
  picked.sort((x, y) => bom.indexOf(x) - bom.indexOf(y));

  const rawW = picked.map((b) => b[3] * (0.8 + 0.4 * rand()));
  const wSum = rawW.reduce((s, v) => s + v, 0);
  const growth = fcTotal / bgTotal;
  const bgRaw = rawW.map((w) => (w / wSum) * bgTotal);
  const fcRaw = bgRaw.map((v) => v * growth * (0.92 + 0.16 * rand()));
  const fcScale = fcTotal / fcRaw.reduce((s, v) => s + v, 0);

  const round2 = (v: number) => Math.round(v * 100) / 100;
  const bg = bgRaw.map(round2);
  const fc = fcRaw.map((v) => round2(v * fcScale));
  // Push rounding drift into the largest line so the totals are exact to the paisa.
  const big = bg.indexOf(Math.max(...bg));
  bg[big] = round2(bg[big] + (bgTotal - bg.reduce((s, v) => s + v, 0)));
  fc[big] = round2(fc[big] + (fcTotal - fc.reduce((s, v) => s + v, 0)));

  return picked.map(([name, unit, price], i) => {
    let quantity: number;
    let unitPrice: number;
    if (unit === 'kg') {
      unitPrice = round2(price * (0.94 + 0.12 * rand()));
      quantity = Math.round((fc[i] / unitPrice) * 1000) / 1000;
    } else {
      quantity = unit === 'pc' ? 1 + Math.floor(rand() * 3) : 1;
      unitPrice = round2(fc[i] / quantity);
    }
    return {
      name: i === 0 ? primaryName : name,
      unit,
      quantity,
      unitPrice,
      bg: bg[i],
      fc: fc[i],
      primary: i === 0,
      isSample: true,
    };
  });
}
