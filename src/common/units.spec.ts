import { INVENTORY_UNITS, normalizeInventoryUnit } from './units';

describe('inventory unit catalog', () => {
  it('contains exactly the units found in PostgreSQL and the Excel file', () => {
    expect(INVENTORY_UNITS.map((unit) => unit.code)).toEqual(['UNIDAD', 'TABLON', 'TABLERO', 'JUEGO']);
  });

  it.each([
    ['UNIDAD', 'UNIDAD'], ['Unidad', 'UNIDAD'], ['unidad', 'UNIDAD'], [' UND ', 'UNIDAD'], ['Unid.', 'UNIDAD'], ['unidades', 'UNIDAD'],
    ['TABLON', 'TABLON'], ['Tablón', 'TABLON'], ['TABLÓN', 'TABLON'], ['tablones', 'TABLON'],
    ['Tablero', 'TABLERO'], ['JUEGO', 'JUEGO'], ['juegos', 'JUEGO'],
  ])('normalizes %p to %p', (raw, expected) => {
    expect(normalizeInventoryUnit(raw)).toBe(expected);
  });

  it.each(['asdasd', 'UNIDADD', 'unddd', 'maderita', 'TABLA', '', null, 'L', 'CAJA'])('rejects %p instead of inventing a unit', (raw) => {
    expect(normalizeInventoryUnit(raw)).toBeNull();
  });
});
