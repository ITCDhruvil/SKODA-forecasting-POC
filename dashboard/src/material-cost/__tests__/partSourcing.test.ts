import { describe, expect, it } from 'vitest';
import type { MaterialPartRow } from '../../types';
import { buildPartSourcing, showsFormerBidder } from '../partSourcing';

function part(overrides: Partial<MaterialPartRow> & Pick<MaterialPartRow, 'partId' | 'project' | 'vendor' | 'category' | 'bgPrice'>): MaterialPartRow {
  return {
    partName: overrides.partId,
    material: 'Steel',
    sopPrice: overrides.bgPrice,
    fcPrice: overrides.bgPrice,
    changeAbs: 0,
    changePct: 0,
    bridges: {},
    ...overrides,
  };
}

const nomination = { month: '2023-07', label: 'Jul 2023' };

describe('buildPartSourcing', () => {
  const awarded = part({
    partId: 'KUS-FST-00001',
    project: 'SKODA Kushaq',
    vendor: 'Bharat Forge',
    category: 'Fasteners',
    bgPrice: 100,
  });
  const sister = part({
    partId: 'TGN-FST-00002',
    project: 'VW Taigun',
    vendor: 'Sundram Fasteners',
    category: 'Fasteners',
    bgPrice: 80,
  });
  const otherCategory = part({
    partId: 'SLV-BDY-00003',
    project: 'SKODA Slavia',
    vendor: 'JBM Auto',
    category: 'Body Stampings',
    bgPrice: 500,
  });
  const sundramElsewhere = part({
    partId: 'KYL-FST-00009',
    project: 'SKODA Kylaq',
    vendor: 'Sundram Fasteners',
    category: 'Fasteners',
    bgPrice: 90,
  });

  it('keeps the awarded quote equal to the nomination price', () => {
    const sourcing = buildPartSourcing(awarded, [awarded, sister, sundramElsewhere], nomination);
    const awardedQuote = sourcing.quotes.find((quote) => quote.awarded);
    expect(awardedQuote?.price).toBe(100);
    expect(sourcing.awardedPrice).toBe(100);
    expect(sourcing.awardYear).toBe(2023);
    expect(sourcing.awardLabel).toBe('Jul 2023');
  });

  it('scales other live quotes by the catalogue price position', () => {
    const partId = ['A', 'B', 'C', 'D', 'E', 'F'].find((id) => !showsFormerBidder(id));
    expect(partId).toBeDefined();
    const sourcing = buildPartSourcing(
      part({ ...awarded, partId: partId! }),
      [awarded, sister, sundramElsewhere],
      nomination,
    );
    const sundram = sourcing.quotes.find((quote) => quote.vendor === 'Sundram Fasteners');
    // Sundram 0.92 / Bharat Forge 1.02, on a nomination price of 100.
    expect(sundram?.price).toBe(90.2);
    expect(sundram?.active).toBe(true);
  });

  it('includes a former bidder who is cheapest and has no live parts', () => {
    expect(showsFormerBidder(awarded.partId)).toBe(true);
    const sourcing = buildPartSourcing(awarded, [awarded, sister, sundramElsewhere], nomination);
    const former = sourcing.quotes.find((quote) => quote.vendor === 'Metro Bolt Works');
    expect(former).toBeDefined();
    expect(former?.active).toBe(false);
    expect(former?.cheapest).toBe(true);
    expect(former?.price).toBeLessThan(100);
    expect(former?.contact?.lastKnown).toBe(true);
    expect(sourcing.cheapestHasLeft).toBe(true);
    expect(sourcing.awardedIsCheapest).toBe(false);
    expect(sourcing.quotes.some((quote) => quote.vendor === 'Bharat Forge' && quote.contact)).toBe(true);
  });

  it('links sister parts in the same category and keeps their own nomination prices', () => {
    const sourcing = buildPartSourcing(awarded, [awarded, sister, otherCategory, sundramElsewhere], nomination);
    const projects = sourcing.programmes.map((row) => row.project);
    expect(projects).toContain('SKODA Kushaq');
    expect(projects).toContain('VW Taigun');
    expect(projects).not.toContain('SKODA Slavia');
    const taigun = sourcing.programmes.find((row) => row.project === 'VW Taigun');
    expect(taigun?.nominationPrice).toBe(80);
    expect(taigun?.vendor).toBe('Sundram Fasteners');
    expect(sourcing.programmeCount).toBe(new Set(projects).size);
  });

  it('repeats the same story for the same part', () => {
    const first = buildPartSourcing(awarded, [awarded, sister], nomination);
    const second = buildPartSourcing(awarded, [awarded, sister], nomination);
    expect(second).toEqual(first);
  });
});
