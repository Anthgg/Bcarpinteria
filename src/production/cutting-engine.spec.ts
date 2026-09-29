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
