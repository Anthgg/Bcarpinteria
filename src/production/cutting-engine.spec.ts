import { suggestCuts } from './cutting-engine';

const board = (id: string, lengthMm: number, widthMm: number, kind: 'BOARD' | 'OFFCUT' = 'BOARD') => ({
  id, code: id, materialId: 'pine', materialName: 'Pino', lengthMm, widthMm, thicknessMm: 18, kind,
});

describe('suggestCuts', () => {
  it('respects kerf when estimating whether pieces fit', () => {
    const result = suggestCuts([
      { id: 'seat', label: 'Asiento', materialId: 'pine', lengthMm: 600, widthMm: 600, thicknessMm: 18, quantity: 2, canRotate: false },
    ], [board('TAB-1', 1200, 600)], 3, 'FULL_BOARDS_FIRST');

    expect(result.summary.placedParts).toBe(1);
    expect(result.unplaced).toHaveLength(1);
    expect(result.boards[0].placements[0]).toMatchObject({ xMm: 0, yMm: 0 });
  });

  it('does not fit two 500 mm pieces along a 1000 mm board when the kerf is 3 mm', () => {
    const result = suggestCuts([
      { id: 'left', label: 'Lado izquierdo', materialId: 'pine', lengthMm: 500, widthMm: 1000, thicknessMm: 18, quantity: 2, canRotate: false },
    ], [board('TAB-1000', 1000, 1000)], 3, 'FULL_BOARDS_FIRST');

    expect(result.summary.placedParts).toBe(1);
    expect(result.unplaced).toHaveLength(1);
  });

  it('rejects placements that would overlap a piece on a neighboring shelf', () => {
    const result = suggestCuts([
      { id: 'first', label: 'Primera', materialId: 'pine', lengthMm: 40, widthMm: 60, thicknessMm: 18, quantity: 1, canRotate: false },
      { id: 'second', label: 'Segunda', materialId: 'pine', lengthMm: 25, widthMm: 80, thicknessMm: 18, quantity: 1, canRotate: false },
      { id: 'third', label: 'Tercera', materialId: 'pine', lengthMm: 60, widthMm: 30, thicknessMm: 18, quantity: 1, canRotate: false },
    ], [board('TAB-100', 100, 100)], 3, 'FULL_BOARDS_FIRST');

    expect(result.summary.placedParts).toBe(2);
    expect(result.unplaced.map((part) => part.label)).toEqual(['Tercera']);
    const [first, second] = result.boards[0].placements;
    expect(second.yMm).toBeGreaterThanOrEqual(first.yMm + first.lengthMm + 3);
  });

  it('does not use boards with another material or thickness', () => {
    const result = suggestCuts([
      { id: 'piece', label: 'Pieza', materialId: 'pine', lengthMm: 500, widthMm: 400, thicknessMm: 18, quantity: 1, canRotate: false },
    ], [
      { ...board('OTHER-MATERIAL', 1300, 700), materialId: 'oak' },
      { ...board('WRONG-THICKNESS', 1300, 700), thicknessMm: 15 },
    ], 3, 'FULL_BOARDS_FIRST');

    expect(result.boards).toHaveLength(0);
    expect(result.unplaced[0].label).toBe('Pieza');
  });

  it('reports an oversized piece as unplaced instead of suggesting an invalid cut', () => {
    const result = suggestCuts([
      { id: 'oversized', label: 'Pieza mayor a la tabla', materialId: 'pine', lengthMm: 1200, widthMm: 600, thicknessMm: 18, quantity: 1, canRotate: false },
    ], [board('TAB-1000', 1000, 1000)], 3, 'FULL_BOARDS_FIRST');

    expect(result.summary.placedParts).toBe(0);
    expect(result.unplaced[0].label).toBe('Pieza mayor a la tabla');
  });

  it('rotates a piece when allowed and favors offcuts when requested', () => {
    const result = suggestCuts([
      { id: 'shelf', label: 'Repisa', materialId: 'pine', lengthMm: 500, widthMm: 1000, thicknessMm: 18, quantity: 1 },
    ], [board('TAB-1', 1300, 700), board('RET-1', 1200, 600, 'OFFCUT')], 3, 'OFFCUTS_FIRST');

    expect(result.boards).toHaveLength(1);
    expect(result.boards[0].code).toBe('RET-1');
    expect(result.boards[0].placements[0].rotated).toBe(true);
    expect(result.boards[0].leftovers.length).toBeGreaterThan(0);
    expect(result.boards[0].leftovers[0]).toHaveProperty('xMm');
  });
});

const stock = (piecesByState: Record<string, number>, looseStock = 0) => [{
  materialId: 'pine', materialName: 'Pino', unit: 'UNIDAD', looseStock, piecesByState,
}];
const part = (quantity: number, lengthMm: number, widthMm: number, thicknessMm = 18, extra: Record<string, unknown> = {}) => ({
  id: 'part', label: 'Pata', materialId: 'pine', lengthMm, widthMm, thicknessMm, quantity, ...extra,
});

describe('suggestCuts diagnostics', () => {
  it('1. explains a material without physical pieces and mentions loose stock', () => {
    const result = suggestCuts([part(4, 750, 60)], [], 3, 'OFFCUTS_FIRST', stock({}, 26));

    expect(result.unplaced).toHaveLength(4);
    expect(result.unplaced.every((entry) => entry.reason === 'NO_PHYSICAL_STOCK')).toBe(true);
    expect(result.diagnostics.primaryReason).toBe('NO_PHYSICAL_STOCK');
    expect(result.diagnostics.groups).toEqual([expect.objectContaining({ label: 'Pata', pending: 4, requested: 4, placed: 0 })]);
    expect(result.unplaced[0].reasonDetails).toContain('Hay 26 unidades de Pino en stock, pero ninguna está registrada como tabla física con medidas');
    expect(result.diagnostics.materials[0]).toMatchObject({ physicalPieces: 0, availablePieces: 0, looseStock: 26 });
  });

  it('2. explains a material whose pieces are all reserved', () => {
    const result = suggestCuts([part(1, 750, 60)], [], 3, 'OFFCUTS_FIRST', stock({ RESERVED: 2, CONSUMED: 1 }));

    expect(result.unplaced[0].reason).toBe('STOCK_RESERVED');
    expect(result.diagnostics.groups[0].funnel).toEqual({ physicalPieces: 3, available: 0, reserved: 2, sameThickness: 0, dimensionCompatible: 0 });
  });

  it('2b. distinguishes pieces that are consumed or pending disposition from reserved ones', () => {
    const result = suggestCuts([part(1, 750, 60)], [], 3, 'OFFCUTS_FIRST', stock({ CONSUMED: 1, PENDING_DISPOSITION: 2 }));

    expect(result.unplaced[0].reason).toBe('NO_AVAILABLE_STOCK');
    expect(result.unplaced[0].reasonDetails).toContain('1 consumida, 2 por decidir');
  });

  it('3. explains a thickness mismatch with the available thicknesses', () => {
    const result = suggestCuts([part(2, 233, 34, 23)], [board('RET-8', 471, 1200, 'OFFCUT')], 3, 'OFFCUTS_FIRST', stock({ AVAILABLE: 1 }));

    expect(result.unplaced.map((entry) => entry.reason)).toEqual(['THICKNESS_MISMATCH', 'THICKNESS_MISMATCH']);
    expect(result.unplaced[0].reasonDetails).toBe('La pieza requiere 23 mm de alto; la pieza disponible de Pino tiene 18 mm.');
    expect(result.diagnostics.groups[0].funnel).toMatchObject({ available: 1, sameThickness: 0 });
  });

  it('4. explains a piece larger than every board, even rotated', () => {
    const result = suggestCuts([part(1, 2500, 1300)], [board('TAB-1', 2400, 1200)], 3, 'FULL_BOARDS_FIRST', stock({ AVAILABLE: 1 }));

    expect(result.unplaced[0].reason).toBe('DIMENSIONS_TOO_LARGE');
    expect(result.unplaced[0].reasonDetails).toContain('la mayor es TAB-1 (2400 × 1200 mm)');
    expect(result.diagnostics.groups[0].funnel).toMatchObject({ sameThickness: 1, dimensionCompatible: 0 });
  });

  it('4b. treats a piece that only fits rotated as too large when rotation is disabled', () => {
    const result = suggestCuts([part(1, 900, 1800, 18, { canRotate: false })], [board('TAB-1', 2400, 1200)], 3, 'FULL_BOARDS_FIRST');

    expect(result.unplaced[0].reason).toBe('DIMENSIONS_TOO_LARGE');
  });

  it('5. places a 900 × 1800 piece rotated on a 2400 × 1200 board', () => {
    const result = suggestCuts([part(1, 900, 1800)], [board('TAB-1', 2400, 1200)], 3, 'FULL_BOARDS_FIRST');

    expect(result.unplaced).toHaveLength(0);
    expect(result.boards[0].placements[0]).toMatchObject({ rotated: true, lengthMm: 1800, widthMm: 900 });
  });

  it('6. reports KERF_NO_FIT when a piece fits geometrically but not with the saw kerf', () => {
    const result = suggestCuts([part(2, 600, 600, 18, { canRotate: false })], [board('TAB-1', 1200, 600)], 3, 'FULL_BOARDS_FIRST');
    const withoutKerf = suggestCuts([part(2, 600, 600, 18, { canRotate: false })], [board('TAB-1', 1200, 600)], 0, 'FULL_BOARDS_FIRST');

    expect(withoutKerf.unplaced).toHaveLength(0);
    expect(result.unplaced).toHaveLength(1);
    expect(result.unplaced[0].reason).toBe('KERF_NO_FIT');
    expect(result.unplaced[0].reasonDetails).toContain('3 mm de corte');
  });

  it('7. reports INSUFFICIENT_REMAINING_SPACE when individual pieces fit but total stock is too small', () => {
    const result = suggestCuts([part(3, 1000, 1000)], [board('TAB-1', 1000, 1000)], 3, 'FULL_BOARDS_FIRST');

    expect(result.summary.placedParts).toBe(1);
    expect(result.unplaced.map((entry) => entry.reason)).toEqual(['INSUFFICIENT_REMAINING_SPACE', 'INSUFFICIENT_REMAINING_SPACE']);
    expect(result.diagnostics.groups).toEqual([expect.objectContaining({ requested: 3, placed: 1, pending: 2, reason: 'INSUFFICIENT_REMAINING_SPACE' })]);
  });

  it('8. returns a partial plan with one group per requirement and reason', () => {
    const result = suggestCuts([
      { ...part(2, 500, 400), id: 'fits', label: 'Lateral' },
      { ...part(1, 500, 400, 25), id: 'thick', label: 'Tapa gruesa' },
    ], [board('TAB-1', 1200, 600)], 3, 'FULL_BOARDS_FIRST', stock({ AVAILABLE: 1 }));

    expect(result.summary).toMatchObject({ requestedParts: 3, placedParts: 2 });
    expect(result.diagnostics).toMatchObject({ requestedParts: 3, placedParts: 2, unplacedParts: 1, primaryReason: 'THICKNESS_MISMATCH' });
    expect(result.diagnostics.groups.map((group) => group.label)).toEqual(['Tapa gruesa']);
  });

  it('9. returns a complete plan with empty diagnostics groups', () => {
    const result = suggestCuts([part(4, 750, 60)], [board('TAB-1', 2400, 1200)], 3, 'FULL_BOARDS_FIRST', stock({ AVAILABLE: 1 }));

    expect(result.summary.placedParts).toBe(4);
    expect(result.unplaced).toEqual([]);
    expect(result.diagnostics).toMatchObject({ unplacedParts: 0, primaryReason: null, groups: [] });
  });

  it('10. uses a compatible offcut', () => {
    const result = suggestCuts([part(1, 400, 300)], [board('RET-1', 471, 1200, 'OFFCUT')], 3, 'FULL_BOARDS_FIRST');

    expect(result.boards.map((entry) => entry.code)).toEqual(['RET-1']);
    expect(result.boards[0].kind).toBe('OFFCUT');
  });

  it('11. uses a full board when no offcut exists', () => {
    const result = suggestCuts([part(1, 1800, 900)], [board('TAB-1', 2400, 1200)], 3, 'OFFCUTS_FIRST');

    expect(result.boards.map((entry) => [entry.code, entry.kind])).toEqual([['TAB-1', 'BOARD']]);
  });

  it('12. OFFCUTS_FIRST prefers an available offcut over a full board', () => {
    const result = suggestCuts([part(1, 400, 300)], [board('TAB-1', 2400, 1200), board('RET-1', 471, 1200, 'OFFCUT')], 3, 'OFFCUTS_FIRST');

    expect(result.boards.map((entry) => entry.code)).toEqual(['RET-1']);
  });

  it('13. FULL_BOARDS_FIRST prefers a full board over an available offcut', () => {
    const result = suggestCuts([part(1, 400, 300)], [board('TAB-1', 2400, 1200), board('RET-1', 471, 1200, 'OFFCUT')], 3, 'FULL_BOARDS_FIRST');

    expect(result.boards.map((entry) => entry.code)).toEqual(['TAB-1']);
  });

  it('regression: BANCO A013 real data (1 mm and 23 mm pieces vs 18 mm stock) is a thickness mismatch', () => {
    const offcuts = [
      board('RET-00005', 1800, 5, 'OFFCUT'), board('RET-00006', 60, 447, 'OFFCUT'),
      board('RET-00007', 60, 447, 'OFFCUT'), board('RET-00008', 471, 1200, 'OFFCUT'),
    ];
    const requirements = [
      { id: 'r1', label: '233rwe', materialId: 'pine', lengthMm: 123, widthMm: 23, thicknessMm: 1, quantity: 1 },
      { id: 'r2', label: 'dwfe', materialId: 'pine', lengthMm: 233, widthMm: 34, thicknessMm: 23, quantity: 15 },
    ];
    const result = suggestCuts(requirements, offcuts, 3, 'OFFCUTS_FIRST', stock({ AVAILABLE: 4, CONSUMED: 1 }));

    expect(result.summary).toMatchObject({ requestedParts: 16, placedParts: 0, boardsUsed: 0 });
    expect(result.diagnostics.primaryReason).toBe('THICKNESS_MISMATCH');
    expect(result.diagnostics.groups.map((group) => [group.label, group.pending, group.reason])).toEqual([
      ['dwfe', 15, 'THICKNESS_MISMATCH'], ['233rwe', 1, 'THICKNESS_MISMATCH'],
    ]);
    expect(result.diagnostics.materials[0]).toMatchObject({ physicalPieces: 5, availablePieces: 4, availableThicknessesMm: [18] });
    // Control: con 18 mm el mismo stock sí alcanza, el motor no tiene un fallo de anidado.
    const control = suggestCuts(requirements.map((entry) => ({ ...entry, thicknessMm: 18 })), offcuts, 3, 'OFFCUTS_FIRST');
    expect(control.summary.placedParts).toBe(16);
  });

  it('regression: PED-00006 positive case keeps its 1/1 plan', () => {
    const result = suggestCuts([{ id: 'qa', label: 'Cubierta QA', materialId: 'pine', lengthMm: 600, widthMm: 450, thicknessMm: 18, quantity: 1 }],
      [board('TAB-00006', 1200, 900)], 3, 'OFFCUTS_FIRST', stock({ AVAILABLE: 1 }));

    expect(result.summary).toMatchObject({ requestedParts: 1, placedParts: 1, boardsUsed: 1 });
    expect(result.unplaced).toEqual([]);
    expect(result.diagnostics.primaryReason).toBeNull();
  });
});
