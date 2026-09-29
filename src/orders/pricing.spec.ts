import { calculateOrderTotals } from './pricing';

describe('calculateOrderTotals', () => {
  it('applies the configured IGV after line discounts using integer cents', () => {
    const totals = calculateOrderTotals([
      { quantity: 2, unitPriceCents: 10000, discountCents: 2500 },
      { quantity: 1, unitPriceCents: 5000, discountCents: 0 },
    ], 1800);

    expect(totals).toMatchObject({
      subtotalCents: 25000,
      discountCents: 2500,
      taxableCents: 22500,
      taxCents: 4050,
      totalCents: 26550,
    });
    expect(totals.lines[0].lineSubtotalCents).toBe(17500);
  });

  it('supports a zero tax rate and rejects a discount larger than its line', () => {
    expect(calculateOrderTotals([{ quantity: 1, unitPriceCents: 999, discountCents: 0 }], 0).totalCents).toBe(999);
    expect(() => calculateOrderTotals([{ quantity: 1, unitPriceCents: 999, discountCents: 1000 }], 1800)).toThrow();
  });

  it('handles fully discounted orders, custom IGV rates, and many small lines in integer cents', () => {
    const zeroed = calculateOrderTotals([{ quantity: 3, unitPriceCents: 250, discountCents: 750 }], 1800);
    expect(zeroed).toMatchObject({ subtotalCents: 750, discountCents: 750, taxableCents: 0, taxCents: 0, totalCents: 0 });

    const manyLines = calculateOrderTotals(
      Array.from({ length: 100 }, () => ({ quantity: 3, unitPriceCents: 1, discountCents: 0 })),
      825,
    );
    expect(manyLines).toMatchObject({ subtotalCents: 300, taxRateBasisPoints: 825, taxCents: 25, totalCents: 325 });
  });

  it('rounds half a cent of tax upward without converting money to floating point', () => {
    const totals = calculateOrderTotals([{ quantity: 1, unitPriceCents: 1, discountCents: 0 }], 5000);
    expect(totals.taxCents).toBe(1);
    expect(totals.totalCents).toBe(2);
  });

  it('rejects line and order totals above PostgreSQL integer cents limits', () => {
    expect(() => calculateOrderTotals([{ quantity: 1, unitPriceCents: 2_147_483_648, discountCents: 0 }], 0)).toThrow(/rango monetario/i);
    expect(() => calculateOrderTotals([
      { quantity: 1, unitPriceCents: 1_200_000_000, discountCents: 0 },
      { quantity: 1, unitPriceCents: 1_200_000_000, discountCents: 0 },
    ], 0)).toThrow(/rango monetario/i);
  });
});
