export interface PriceLineInput {
  quantity: number;
  unitPriceCents: number;
  discountCents: number;
}

export interface PriceLineTotals extends PriceLineInput {
  grossCents: number;
  lineSubtotalCents: number;
}

export interface OrderTotals {
  lines: PriceLineTotals[];
  subtotalCents: number;
  discountCents: number;
  taxableCents: number;
  taxRateBasisPoints: number;
  taxCents: number;
  totalCents: number;
}

export function calculateOrderTotals(lines: PriceLineInput[], taxRateBasisPoints: number): OrderTotals {
  const maxDatabaseInteger = 2_147_483_647;
  if (!Number.isInteger(taxRateBasisPoints) || taxRateBasisPoints < 0 || taxRateBasisPoints > 10000) {
    throw new Error('La tasa de impuesto debe ser un entero entre 0 y 10000 puntos base.');
  }
  const pricedLines = lines.map((line) => {
    if (!Number.isInteger(line.quantity) || line.quantity < 1
      || !Number.isInteger(line.unitPriceCents) || line.unitPriceCents < 0
      || !Number.isInteger(line.discountCents) || line.discountCents < 0) {
      throw new Error('La cantidad, el precio y el descuento deben ser valores enteros no negativos.');
    }
    const grossCents = line.quantity * line.unitPriceCents;
    if (!Number.isSafeInteger(grossCents) || grossCents > maxDatabaseInteger) throw new Error('El importe de la línea excede el rango monetario permitido.');
    if (line.discountCents > grossCents) throw new Error('El descuento no puede superar el importe de la línea.');
    const lineSubtotalCents = grossCents - line.discountCents;
    if (lineSubtotalCents > maxDatabaseInteger) throw new Error('La línea excede el rango monetario permitido.');
    return { ...line, grossCents, lineSubtotalCents };
  });
  const subtotalCents = pricedLines.reduce((sum, line) => sum + line.grossCents, 0);
  const discountCents = pricedLines.reduce((sum, line) => sum + line.discountCents, 0);
  const taxableCents = subtotalCents - discountCents;
  if (![subtotalCents, discountCents, taxableCents].every((value) => Number.isSafeInteger(value) && value <= maxDatabaseInteger)) throw new Error('El pedido excede el rango monetario permitido.');
  const taxCents = Math.floor((taxableCents * taxRateBasisPoints + 5000) / 10000);
  const totalCents = taxableCents + taxCents;
  if (!Number.isSafeInteger(taxCents) || taxCents > maxDatabaseInteger || !Number.isSafeInteger(totalCents) || totalCents > maxDatabaseInteger) throw new Error('El pedido excede el rango monetario permitido.');
  return { lines: pricedLines, subtotalCents, discountCents, taxableCents, taxRateBasisPoints, taxCents, totalCents };
}
