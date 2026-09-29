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
