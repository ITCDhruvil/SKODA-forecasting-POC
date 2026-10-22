import type { MaterialPartRow } from '../types';

/**
 * Commercial context for one part, derived from the parts already on the
 * dashboard. Nomination, SOP, and forecast prices are never rewritten.
 * Quote levels follow each vendor's existing price position, and the
 * awarded quote is the part's nomination unit price.
 */

export interface SourcingContact {
  desk: string;
  phone: string;
  email: string;
  lastKnown: boolean;
}

export interface SourcingProgramme {
  partId: string;
  project: string;
  vendor: string;
  nominationPrice: number;
  isCurrent: boolean;
}

export interface SourcingQuote {
  vendor: string;
  price: number;
  awarded: boolean;
  cheapest: boolean;
  active: boolean;
  contact?: SourcingContact;
}

export interface PartSourcing {
  programmeCount: number;
  programmes: SourcingProgramme[];
  awardYear: number | null;
  awardLabel: string;
  awardedVendor: string;
  awardedPrice: number;
  cheapestVendor: string;
  cheapestPrice: number;
  awardedIsCheapest: boolean;
  cheapestHasLeft: boolean;
  quotes: SourcingQuote[];
}

interface Supplier {
  code: string;
  name: string;
  priceIndex: number;
  phone: string;
  email: string;
}

const LIVE_SUPPLIERS: Supplier[] = [
  { code: 'SFL', name: 'Sundram Fasteners', priceIndex: 0.92, phone: '+91 44 6700 1101', email: 'sourcing@sfl.demo.example' },
  { code: 'BFL', name: 'Bharat Forge', priceIndex: 1.02, phone: '+91 20 6700 1102', email: 'sourcing@bfl.demo.example' },
  { code: 'END', name: 'Endurance Technologies', priceIndex: 0.97, phone: '+91 240 6700 1103', email: 'sourcing@end.demo.example' },
  { code: 'MND', name: 'Minda Industries', priceIndex: 0.99, phone: '+91 120 6700 1104', email: 'sourcing@mnd.demo.example' },
  { code: 'SNA', name: 'Sona BLW', priceIndex: 1.05, phone: '+91 124 6700 1105', email: 'sourcing@sna.demo.example' },
  { code: 'GAB', name: 'Gabriel India', priceIndex: 0.94, phone: '+91 20 6700 1106', email: 'sourcing@gab.demo.example' },
  { code: 'LUM', name: 'Lumax Industries', priceIndex: 0.98, phone: '+91 120 6700 1107', email: 'sourcing@lum.demo.example' },
  { code: 'SND', name: 'Sandhar Technologies', priceIndex: 0.95, phone: '+91 124 6700 1108', email: 'sourcing@snd.demo.example' },
  { code: 'JBM', name: 'JBM Auto', priceIndex: 0.93, phone: '+91 120 6700 1109', email: 'sourcing@jbm.demo.example' },
  { code: 'RNE', name: 'Rane Group', priceIndex: 0.96, phone: '+91 44 6700 1110', email: 'sourcing@rne.demo.example' },
  { code: 'SUB', name: 'Subros', priceIndex: 1.0, phone: '+91 124 6700 1111', email: 'sourcing@sub.demo.example' },
  { code: 'VRC', name: 'Varroc Engineering', priceIndex: 0.98, phone: '+91 240 6700 1112', email: 'sourcing@vrc.demo.example' },
  { code: 'BSH', name: 'Bosch India', priceIndex: 1.18, phone: '+91 80 6700 1113', email: 'sourcing@bsh.demo.example' },
  { code: 'CNT', name: 'Continental India', priceIndex: 1.15, phone: '+91 80 6700 1114', email: 'sourcing@cnt.demo.example' },
  { code: 'ZFI', name: 'ZF India', priceIndex: 1.14, phone: '+91 20 6700 1115', email: 'sourcing@zfi.demo.example' },
  { code: 'VLO', name: 'Valeo India', priceIndex: 1.12, phone: '+91 44 6700 1116', email: 'sourcing@vlo.demo.example' },
  { code: 'MHL', name: 'Mahle India', priceIndex: 1.09, phone: '+91 20 6700 1117', email: 'sourcing@mhl.demo.example' },
  { code: 'DNS', name: 'Denso India', priceIndex: 1.13, phone: '+91 124 6700 1118', email: 'sourcing@dns.demo.example' },
  { code: 'APT', name: 'Aptiv India', priceIndex: 1.16, phone: '+91 44 6700 1119', email: 'sourcing@apt.demo.example' },
  { code: 'BRS', name: 'Brose India', priceIndex: 1.1, phone: '+91 20 6700 1120', email: 'sourcing@brs.demo.example' },
];

/** Former suppliers. Names sit outside the live vendor list, one category each. */
const FORMER_SUPPLIERS: Array<Supplier & { category: string }> = [
  { category: 'Fasteners', code: 'MBW', name: 'Metro Bolt Works', priceIndex: 0.84, phone: '+91 20 6700 2101', email: 'sourcing@mbw.demo.example' },
  { category: 'Body Stampings', code: 'DCP', name: 'Deccan Pressings', priceIndex: 0.86, phone: '+91 20 6700 2102', email: 'sourcing@dcp.demo.example' },
  { category: 'Chassis', code: 'WAC', name: 'Western Axle Components', priceIndex: 0.86, phone: '+91 20 6700 2103', email: 'sourcing@wac.demo.example' },
  { category: 'Braking', code: 'HFS', name: 'Hind Friction Systems', priceIndex: 0.84, phone: '+91 44 6700 2104', email: 'sourcing@hfs.demo.example' },
  { category: 'Powertrain', code: 'PAC', name: 'Pune Aluminium Castings', priceIndex: 0.88, phone: '+91 20 6700 2105', email: 'sourcing@pac.demo.example' },
  { category: 'Interior Trim', code: 'SPT', name: 'Shakti Polymer Trim', priceIndex: 0.86, phone: '+91 124 6700 2106', email: 'sourcing@spt.demo.example' },
  { category: 'HVAC', code: 'CLT', name: 'Coolline Thermal', priceIndex: 0.88, phone: '+91 124 6700 2107', email: 'sourcing@clt.demo.example' },
  { category: 'Electrical', code: 'NXW', name: 'Nexus Wiring', priceIndex: 0.86, phone: '+91 120 6700 2108', email: 'sourcing@nxw.demo.example' },
  { category: 'Lighting', code: 'ALS', name: 'Arya Lamp Systems', priceIndex: 0.86, phone: '+91 120 6700 2109', email: 'sourcing@als.demo.example' },
  { category: 'Sensors', code: 'VSC', name: 'Vector Sensorics', priceIndex: 0.96, phone: '+91 80 6700 2110', email: 'sourcing@vsc.demo.example' },
];

/** Vendors allowed to quote each category. Mirrors the generation catalogue. */
const CATEGORY_SUPPLIERS: Record<string, string[]> = {
  Fasteners: ['SFL', 'BFL', 'JBM', 'SND'],
  'Body Stampings': ['JBM', 'BFL', 'SND', 'END'],
  Chassis: ['BFL', 'END', 'GAB', 'SNA', 'ZFI'],
  Braking: ['END', 'RNE', 'BSH', 'CNT', 'ZFI'],
  Powertrain: ['SNA', 'BFL', 'MHL', 'ZFI', 'END'],
  'Interior Trim': ['MND', 'VRC', 'SND', 'BRS', 'LUM'],
  HVAC: ['SUB', 'DNS', 'VLO', 'MHL'],
  Electrical: ['MND', 'VRC', 'BSH', 'APT', 'CNT', 'DNS'],
  Lighting: ['LUM', 'VRC', 'MND', 'VLO'],
  Sensors: ['BSH', 'CNT', 'DNS', 'APT', 'VLO'],
};

const LIVE_BY_CODE = new Map(LIVE_SUPPLIERS.map((vendor) => [vendor.code, vendor]));
const LIVE_BY_NAME = new Map(LIVE_SUPPLIERS.map((vendor) => [vendor.name, vendor]));

/** About half of parts include the category's former bidder. Stable per part id. */
export function showsFormerBidder(partId: string): boolean {
  let hash = 2166136261;
  for (let i = 0; i < partId.length; i += 1) {
    hash ^= partId.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) % 2 === 0;
}

function roundMoney(value: number): number {
  return Math.round(value * 100) / 100;
}

function familyMembers(part: MaterialPartRow, parts: MaterialPartRow[]): MaterialPartRow[] {
  const sameCategory = parts.filter((row) => row.category === part.category);
  const byProject = new Map<string, MaterialPartRow[]>();
  for (const row of sameCategory) {
    const column = byProject.get(row.project) ?? [];
    column.push(row);
    byProject.set(row.project, column);
  }
  const projects = [...byProject.keys()].sort();
  const columns = projects.map((project) =>
    (byProject.get(project) ?? []).slice().sort((a, b) => a.partId.localeCompare(b.partId)),
  );
  const projectIndex = projects.indexOf(part.project);
  const index = columns[projectIndex]?.findIndex((row) => row.partId === part.partId) ?? -1;
  if (index < 0) return [part];
  return columns
    .map((column) => column[index])
    .filter((row): row is MaterialPartRow => row != null);
}

export function buildPartSourcing(
  part: MaterialPartRow,
  allParts: MaterialPartRow[],
  nomination?: { month: string; label: string },
): PartSourcing {
  const pool = allParts.some((row) => row.partId === part.partId)
    ? allParts
    : [...allParts, part];
  const activeNames = new Set(pool.map((row) => row.vendor));
  const awarded = LIVE_BY_NAME.get(part.vendor);
  const awardedIndex = awarded?.priceIndex ?? 1;
  const yearMatch = nomination?.month.match(/^(\d{4})/);

  const bidders: Array<Supplier & { former: boolean }> = [];
  for (const code of CATEGORY_SUPPLIERS[part.category] ?? []) {
    const vendor = LIVE_BY_CODE.get(code);
    if (vendor) bidders.push({ ...vendor, former: false });
  }
  if (!bidders.some((bidder) => bidder.name === part.vendor)) {
    bidders.push({
      code: 'AWARDED',
      name: part.vendor,
      priceIndex: awardedIndex,
      phone: awarded?.phone ?? '+91 20 6700 0000',
      email: awarded?.email ?? 'sourcing@awarded.demo.example',
      former: false,
    });
  }
  const former = FORMER_SUPPLIERS.find((supplier) => supplier.category === part.category);
  if (former && showsFormerBidder(part.partId)) {
    bidders.push({ ...former, former: true });
  }

  const quotes: SourcingQuote[] = bidders.map((bidder) => {
    const price =
      bidder.name === part.vendor
        ? part.bgPrice
        : roundMoney(part.bgPrice * (bidder.priceIndex / awardedIndex));
    const active = !bidder.former && activeNames.has(bidder.name);
    return {
      vendor: bidder.name,
      price,
      awarded: bidder.name === part.vendor,
      cheapest: false,
      active,
      contact: undefined,
    };
  });

  const cheapest = [...quotes].sort(
    (a, b) => a.price - b.price || a.vendor.localeCompare(b.vendor),
  )[0];

  for (const quote of quotes) {
    quote.cheapest = quote.vendor === cheapest.vendor;
    if (!quote.awarded && !quote.cheapest) continue;
    const bidder = bidders.find((row) => row.name === quote.vendor);
    if (!bidder) continue;
    quote.contact = {
      desk: quote.active ? 'Sourcing desk' : 'Last known desk',
      phone: bidder.phone,
      email: bidder.email,
      lastKnown: !quote.active,
    };
  }

  quotes.sort((a, b) => a.price - b.price || a.vendor.localeCompare(b.vendor));

  const programmes = familyMembers(part, pool)
    .map((row) => ({
      partId: row.partId,
      project: row.project,
      vendor: row.vendor,
      nominationPrice: row.bgPrice,
      isCurrent: row.partId === part.partId,
    }))
    .sort((a, b) => a.project.localeCompare(b.project));

  return {
    programmeCount: new Set(programmes.map((row) => row.project)).size,
    programmes,
    awardYear: yearMatch ? Number(yearMatch[1]) : null,
    awardLabel: nomination?.label ?? 'Nomination',
    awardedVendor: part.vendor,
    awardedPrice: part.bgPrice,
    cheapestVendor: cheapest.vendor,
    cheapestPrice: cheapest.price,
    awardedIsCheapest: cheapest.vendor === part.vendor,
    cheapestHasLeft: !cheapest.active,
    quotes,
  };
}
