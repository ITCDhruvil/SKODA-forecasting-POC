import { describe, it, expect } from 'vitest';
import { buildOfferExportHandler, offerExportDefinition, type ExportOffer } from '../exportOffer';

function collector() {
  const offers: ExportOffer[] = [];
  return { offers, handler: buildOfferExportHandler((o) => offers.push(o)) };
}

describe('offerExportDefinition', () => {
  it('declares the six catalog ids and both formats', () => {
    const params = offerExportDefinition().function.parameters as Record<string, any>;
    expect(params.properties.format.enum).toEqual(['xlsx', 'docx']);
    expect(params.properties.export.enum).toHaveLength(6);
    expect(params.required).toEqual(['format', 'label']);
  });
});

describe('buildOfferExportHandler', () => {
  it('emits an offer and acknowledges it back to the model', () => {
    const { offers, handler } = collector();
    const ack = handler({ format: 'xlsx', label: 'Top 20 rising parts', export: 'top_movers', direction: 'up', n: 20 });

    expect(ack).toEqual({ ok: true, offered: 'xlsx', label: 'Top 20 rising parts' });
    expect(offers).toHaveLength(1);
    expect(offers[0]).toEqual({
      format: 'xlsx',
      label: 'Top 20 rising parts',
      dataRef: { export: 'top_movers', params: { direction: 'up', n: 20 } },
    });
  });

  it('allows a docx offer with no data reference', () => {
    const { offers, handler } = collector();
    handler({ format: 'docx', label: 'Freight shock write-up' });
    expect(offers[0].dataRef).toBeNull();
  });

  it('rejects an xlsx offer with no data reference', () => {
    const { offers, handler } = collector();
    const result = handler({ format: 'xlsx', label: 'Nothing' }) as { error?: string };
    expect(result.error).toBeTruthy();
    expect(offers).toHaveLength(0);
  });

  it('rejects an unknown format', () => {
    const { offers, handler } = collector();
    expect(handler({ format: 'pdf', label: 'x', export: 'alerts' })).toHaveProperty('error');
    expect(offers).toHaveLength(0);
  });

  it('rejects an unknown export id', () => {
    const { offers, handler } = collector();
    expect(handler({ format: 'xlsx', label: 'x', export: 'everything' })).toHaveProperty('error');
    expect(offers).toHaveLength(0);
  });

  it('rejects a missing or empty label', () => {
    const { handler } = collector();
    expect(handler({ format: 'xlsx', export: 'alerts' })).toHaveProperty('error');
    expect(handler({ format: 'xlsx', export: 'alerts', label: '   ' })).toHaveProperty('error');
  });

  it('treats a repeated identical call as already offered, not as a new offer', () => {
    const { offers, handler } = collector();
    handler({ format: 'xlsx', label: 'Alerts', export: 'alerts' });
    const second = handler({ format: 'xlsx', label: 'Alerts', export: 'alerts' });
    expect(second).toEqual({ ok: true, note: 'already offered' });
    expect(offers).toHaveLength(1);
  });

  it('caps at one offer per answer', () => {
    const { offers, handler } = collector();
    handler({ format: 'xlsx', label: 'Alerts', export: 'alerts' });
    const second = handler({ format: 'xlsx', label: 'Categories', export: 'category_breakdown' }) as { error?: string };
    expect(second.error).toContain('limit');
    expect(offers).toHaveLength(1);
  });

  it('drops undefined params rather than writing them into dataRef', () => {
    const { offers, handler } = collector();
    handler({ format: 'xlsx', label: 'Alerts', export: 'alerts', direction: undefined });
    expect(offers[0].dataRef).toEqual({ export: 'alerts', params: {} });
  });
});
