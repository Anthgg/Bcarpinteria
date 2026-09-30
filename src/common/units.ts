/**
 * Catálogo controlado de unidades de inventario: fuente única de verdad (el frontend lo lee de GET /inventory/units).
 *
 * Derivado de los datos reales (auditoría 2026-09-30): PostgreSQL usa UNIDAD, TABLON, TABLERO y JUEGO;
 * el Excel de inventario usa UNIDAD y JUEGO. TABLÓN (madera maciza) y TABLERO (panel) son unidades distintas.
 * No confundir con la unidad dimensional (mm, cm, m), que solo indica cómo se escriben las medidas.
 */
export const INVENTORY_UNITS = [
  { code: 'UNIDAD', label: 'Unidad', plural: 'Unidades' },
  { code: 'TABLON', label: 'Tablón', plural: 'Tablones' },
  { code: 'TABLERO', label: 'Tablero', plural: 'Tableros' },
  { code: 'JUEGO', label: 'Juego', plural: 'Juegos' },
] as const;

export type InventoryUnit = (typeof INVENTORY_UNITS)[number]['code'];
const CODES = new Set<string>(INVENTORY_UNITS.map((unit) => unit.code));

/**
 * Equivalencias explícitas (sin tildes, en mayúsculas y sin punto final). Solo sinónimos inequívocos:
 * "TABLA" no se mapea porque podría ser tablón o tablero.
 */
const ALIASES: Record<string, InventoryUnit> = {
  UND: 'UNIDAD', UNID: 'UNIDAD', UNIDADES: 'UNIDAD', UN: 'UNIDAD',
  TABLONES: 'TABLON',
  TABLEROS: 'TABLERO',
  JUEGOS: 'JUEGO',
};

const canonical = (value: unknown) => String(value ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim().toUpperCase().replace(/\.$/, '');

/** Devuelve el código del catálogo o null si la unidad no es reconocida (nunca inventa una unidad nueva). */
export function normalizeInventoryUnit(value: unknown): InventoryUnit | null {
  const key = canonical(value);
  if (CODES.has(key)) return key as InventoryUnit;
  return ALIASES[key] ?? null;
}
