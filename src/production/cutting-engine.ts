export interface CutBoard {
  id: string;
  code: string;
  materialId: string;
  materialName: string;
  lengthMm: number;
  widthMm: number;
  thicknessMm: number;
  kind: 'BOARD' | 'OFFCUT';
}

export interface CutRequirement {
  id: string;
  label: string;
  materialId: string;
  lengthMm: number;
  widthMm: number;
  thicknessMm: number;
  quantity: number;
  canRotate?: boolean;
}

export type CutStrategy = 'OFFCUTS_FIRST' | 'FULL_BOARDS_FIRST';

/** Límite único del ancho de corte (kerf), en mm enteros: lo aplican el motor, la simulación y Configuración. */
export const MAX_KERF_MM = 100;

export interface CutPlacement {
  requirementId: string;
  label: string;
  xMm: number;
  yMm: number;
  lengthMm: number;
  widthMm: number;
  rotated: boolean;
}

export interface CutLeftover {
  xMm: number;
  yMm: number;
  lengthMm: number;
  widthMm: number;
  thicknessMm: number;
}

export interface PlannedBoard extends CutBoard {
  placements: CutPlacement[];
  leftovers: CutLeftover[];
  cutsEstimated: number;
  utilizationPercent: number;
  wasteAreaMm2: number;
}

/**
 * Motivo por el que una pieza no se ubicó. Se evalúa en este orden (embudo):
 * existencia física → disponibilidad → alto/espesor → largo/ancho (con giro) → espacio tras anidar.
 */
export type UnplacedReason =
  | 'NO_PHYSICAL_STOCK'            // el material no tiene ninguna pieza física registrada
  | 'STOCK_RESERVED'               // hay piezas, pero ninguna AVAILABLE y al menos una RESERVED
  | 'NO_AVAILABLE_STOCK'           // hay piezas, pero todas consumidas / por decidir / descartadas
  | 'THICKNESS_MISMATCH'           // hay piezas disponibles, pero ninguna con el mismo alto (espesor)
  | 'DIMENSIONS_TOO_LARGE'         // mismo alto, pero la pieza no cabe (ni girada) en ninguna tabla vacía
  | 'KERF_NO_FIT'                  // cabría en el espacio restante si el corte de sierra fuese 0 mm
  | 'INSUFFICIENT_REMAINING_SPACE' // cabe en una tabla vacía, pero el espacio se agotó con otras piezas
  | 'UNKNOWN';

/** Contexto de inventario del material (todas las piezas, no solo las disponibles). */
export interface MaterialStockContext {
  materialId: string;
  materialName: string;
  unit: string;
  looseStock: number;
  piecesByState: Partial<Record<string, number>>;
}

export interface UnplacedPart {
  id: string;
  requirementId: string;
  label: string;
  materialId: string;
  lengthMm: number;
  widthMm: number;
  thicknessMm: number;
  reason: UnplacedReason;
  reasonDetails: string;
}

export interface CandidateFunnel {
  physicalPieces: number;
  available: number;
  reserved: number;
  sameThickness: number;
  dimensionCompatible: number;
}

export interface UnplacedGroup {
  requirementId: string;
  label: string;
  materialId: string;
  materialName: string;
  lengthMm: number;
  widthMm: number;
  thicknessMm: number;
  requested: number;
  placed: number;
  pending: number;
  reason: UnplacedReason;
  reasonDetails: string;
  funnel: CandidateFunnel;
}

export interface MaterialDiagnostic {
  materialId: string;
  materialName: string;
  unit: string;
  looseStock: number;
  physicalPieces: number;
  availablePieces: number;
  reservedPieces: number;
  piecesByState: Partial<Record<string, number>>;
  availableThicknessesMm: number[];
}

export interface CuttingDiagnostics {
  requestedParts: number;
  placedParts: number;
  unplacedParts: number;
  primaryReason: UnplacedReason | null;
  materials: MaterialDiagnostic[];
  groups: UnplacedGroup[];
}

export interface CuttingResult {
  strategy: CutStrategy;
  kerfMm: number;
  boards: PlannedBoard[];
  unplaced: UnplacedPart[];
  diagnostics: CuttingDiagnostics;
  summary: {
    requestedParts: number;
    placedParts: number;
    boardsUsed: number;
    cutsEstimated: number;
    totalAreaMm2: number;
    usedAreaMm2: number;
    wasteAreaMm2: number;
    utilizationPercent: number;
  };
}

interface PartInstance {
  id: string;
  requirementId: string;
  label: string;
  materialId: string;
  lengthMm: number;
  widthMm: number;
  thicknessMm: number;
  canRotate: boolean;
}

interface Shelf {
  yMm: number;
  heightMm: number;
  cursorXMm: number;
}

const area = (length: number, width: number) => length * width;
const validDimension = (value: number) => Number.isInteger(value) && value > 0;

function expandedParts(requirements: CutRequirement[]): PartInstance[] {
  const parts: PartInstance[] = [];
  for (const requirement of requirements) {
    if (![requirement.lengthMm, requirement.widthMm, requirement.thicknessMm, requirement.quantity].every(validDimension)) {
      throw new Error(`Medidas o cantidad inválidas para ${requirement.label}.`);
    }
    for (let i = 0; i < requirement.quantity; i += 1) {
      parts.push({
        id: `${requirement.id}:${i + 1}`,
        requirementId: requirement.id,
        label: requirement.label,
        materialId: requirement.materialId,
        lengthMm: requirement.lengthMm,
        widthMm: requirement.widthMm,
        thicknessMm: requirement.thicknessMm,
        canRotate: requirement.canRotate ?? true,
      });
    }
  }
  return parts.sort((a, b) => area(b.lengthMm, b.widthMm) - area(a.lengthMm, a.widthMm)
    || Math.max(b.lengthMm, b.widthMm) - Math.max(a.lengthMm, a.widthMm));
}

function fitBoard(board: CutBoard, available: PartInstance[], kerfMm: number): { result: PlannedBoard; remaining: PartInstance[] } {
  const shelves: Shelf[] = [];
  const placements: CutPlacement[] = [];
  const remaining: PartInstance[] = [];
  let usedArea = 0;
  const overlapsWithKerf = (xMm: number, yMm: number, lengthMm: number, widthMm: number) =>
    placements.some((placement) =>
      xMm < placement.xMm + placement.widthMm + kerfMm
      && xMm + widthMm + kerfMm > placement.xMm
      && yMm < placement.yMm + placement.lengthMm + kerfMm
      && yMm + lengthMm + kerfMm > placement.yMm);

  for (const part of available) {
    if (part.materialId !== board.materialId || part.thicknessMm !== board.thicknessMm) {
      remaining.push(part);
      continue;
    }

    const orientations = [{ length: part.lengthMm, width: part.widthMm, rotated: false }];
    if (part.canRotate && part.lengthMm !== part.widthMm) {
      orientations.push({ length: part.widthMm, width: part.lengthMm, rotated: true });
    }
    let chosen: { shelfIndex: number; length: number; width: number; rotated: boolean; score: number } | null = null;
    for (const orientation of orientations) {
      if (orientation.width > board.widthMm || orientation.length > board.lengthMm) continue;
      for (let shelfIndex = 0; shelfIndex < shelves.length; shelfIndex += 1) {
        const shelf = shelves[shelfIndex];
        const x = shelf.cursorXMm === 0 ? 0 : shelf.cursorXMm + kerfMm;
        const yExtent = shelf.yMm + Math.max(shelf.heightMm, orientation.length);
        if (x + orientation.width > board.widthMm || yExtent > board.lengthMm) continue;
        if (overlapsWithKerf(x, shelf.yMm, orientation.length, orientation.width)) continue;
        const score = (board.widthMm - x - orientation.width) + (board.lengthMm - yExtent) * 0.01;
        if (!chosen || score < chosen.score) chosen = { shelfIndex, ...orientation, score };
      }
    }
    if (!chosen) {
      for (const orientation of orientations) {
        if (orientation.width > board.widthMm || orientation.length > board.lengthMm) continue;
        const y = shelves.length === 0 ? 0 : Math.max(...shelves.map((shelf) => shelf.yMm + shelf.heightMm)) + kerfMm;
        if (y + orientation.length > board.lengthMm) continue;
        if (overlapsWithKerf(0, y, orientation.length, orientation.width)) continue;
        const score = (board.widthMm - orientation.width) + (board.lengthMm - y - orientation.length) * 0.01;
        if (!chosen || score < chosen.score) chosen = { shelfIndex: shelves.length, ...orientation, score };
      }
      if (chosen) shelves.push({ yMm: shelves.length === 0 ? 0 : Math.max(...shelves.map((shelf) => shelf.yMm + shelf.heightMm)) + kerfMm, heightMm: 0, cursorXMm: 0 });
    }
    if (!chosen) {
      remaining.push(part);
      continue;
    }
    const shelf = shelves[chosen.shelfIndex];
    const xMm = shelf.cursorXMm === 0 ? 0 : shelf.cursorXMm + kerfMm;
    placements.push({
      requirementId: part.id,
      label: part.label,
      xMm,
      yMm: shelf.yMm,
      lengthMm: chosen.length,
      widthMm: chosen.width,
      rotated: chosen.rotated,
    });
    shelf.cursorXMm = xMm + chosen.width;
    shelf.heightMm = Math.max(shelf.heightMm, chosen.length);
    usedArea += area(chosen.length, chosen.width);
  }

  const leftovers: CutLeftover[] = [];
  for (const shelf of shelves) {
    const width = board.widthMm - shelf.cursorXMm - (shelf.cursorXMm < board.widthMm ? kerfMm : 0);
    if (width > 0 && shelf.heightMm > 0) leftovers.push({
      xMm: shelf.cursorXMm + kerfMm,
      yMm: shelf.yMm,
      lengthMm: shelf.heightMm,
      widthMm: width,
      thicknessMm: board.thicknessMm,
    });
  }
  const usedLength = shelves.length ? Math.max(...shelves.map((shelf) => shelf.yMm + shelf.heightMm)) : 0;
  const bottomLength = board.lengthMm - usedLength - (usedLength < board.lengthMm ? kerfMm : 0);
  if (bottomLength > 0) leftovers.push({
    xMm: 0,
    yMm: usedLength + kerfMm,
    lengthMm: bottomLength,
    widthMm: board.widthMm,
    thicknessMm: board.thicknessMm,
  });
  const boardArea = area(board.lengthMm, board.widthMm);
  const wasteArea = Math.max(0, boardArea - usedArea);
  return {
    result: {
      ...board,
      placements,
      leftovers,
      cutsEstimated: placements.length ? placements.length + shelves.length : 0,
      utilizationPercent: boardArea ? Number(((usedArea / boardArea) * 100).toFixed(1)) : 0,
      wasteAreaMm2: wasteArea,
    },
    remaining,
  };
}

function nest(parts: PartInstance[], boards: CutBoard[], kerfMm: number, strategy: CutStrategy) {
  let pending = parts;
  const orderedBoards = [...boards].sort((a, b) => {
    const offcutFirst = strategy === 'OFFCUTS_FIRST';
    const kindOrder = (piece: CutBoard) => piece.kind === 'OFFCUT' ? (offcutFirst ? 0 : 1) : (offcutFirst ? 1 : 0);
    return kindOrder(a) - kindOrder(b)
      || area(a.lengthMm, a.widthMm) - area(b.lengthMm, b.widthMm);
  });
  const planned: PlannedBoard[] = [];
  for (const board of orderedBoards) {
    if (!pending.some((part) => part.materialId === board.materialId && part.thicknessMm === board.thicknessMm)) continue;
    const { result, remaining } = fitBoard(board, pending, kerfMm);
    if (result.placements.length) planned.push(result);
    pending = remaining;
  }
  return { planned, pending };
}

/** Misma regla de orientación que fitBoard: largo contra largo y ancho contra ancho, o girada si se permite. */
const fitsEmptyBoard = (part: Pick<PartInstance, 'lengthMm' | 'widthMm' | 'canRotate'>, board: CutBoard) =>
  (part.lengthMm <= board.lengthMm && part.widthMm <= board.widthMm)
  || (part.canRotate && part.widthMm <= board.lengthMm && part.lengthMm <= board.widthMm);

const STATE_LABELS: Record<string, [string, string]> = {
  AVAILABLE: ['disponible', 'disponibles'], RESERVED: ['reservada', 'reservadas'], PENDING_DISPOSITION: ['por decidir', 'por decidir'],
  CONSUMED: ['consumida', 'consumidas'], DISCARDED: ['descartada', 'descartadas'],
};
const plural = (count: number, singular: string, pluralForm: string) => `${count} ${count === 1 ? singular : pluralForm}`;
const stateBreakdown = (byState: Partial<Record<string, number>>) =>
  Object.entries(byState).filter(([, count]) => count)
    .map(([state, count]) => plural(count!, ...(STATE_LABELS[state] ?? [state.toLowerCase(), state.toLowerCase()]))).join(', ');

function materialDiagnostics(
  requirements: CutRequirement[],
  boards: CutBoard[],
  stock: MaterialStockContext[] | undefined,
): Map<string, MaterialDiagnostic> {
  const result = new Map<string, MaterialDiagnostic>();
  for (const materialId of new Set(requirements.map((requirement) => requirement.materialId))) {
    const context = stock?.find((entry) => entry.materialId === materialId);
    const availableBoards = boards.filter((board) => board.materialId === materialId);
    const piecesByState = context?.piecesByState ?? (availableBoards.length ? { AVAILABLE: availableBoards.length } : {});
    result.set(materialId, {
      materialId,
      materialName: context?.materialName ?? availableBoards[0]?.materialName ?? 'Material',
      unit: context?.unit ?? 'UNIDAD',
      looseStock: context?.looseStock ?? 0,
      physicalPieces: Object.values(piecesByState).reduce<number>((sum, count) => sum + (count ?? 0), 0),
      availablePieces: availableBoards.length,
      reservedPieces: piecesByState.RESERVED ?? 0,
      piecesByState,
      availableThicknessesMm: [...new Set(availableBoards.map((board) => board.thicknessMm))].sort((a, b) => a - b),
    });
  }
  return result;
}

/** Motivo previo al anidado; null significa que la pieza cabe sola en al menos una tabla disponible. */
function precheck(part: PartInstance, material: MaterialDiagnostic, boards: CutBoard[]): { funnel: CandidateFunnel; reason: UnplacedReason | null; details: string } {
  const available = boards.filter((board) => board.materialId === part.materialId);
  const sameThickness = available.filter((board) => board.thicknessMm === part.thicknessMm);
  const compatible = sameThickness.filter((board) => fitsEmptyBoard(part, board));
  const funnel: CandidateFunnel = {
    physicalPieces: material.physicalPieces,
    available: available.length,
    reserved: material.reservedPieces,
    sameThickness: sameThickness.length,
    dimensionCompatible: compatible.length,
  };
  const name = material.materialName;
  if (!material.physicalPieces) {
    const details = material.looseStock > 0
      ? `Hay ${material.looseStock} ${material.unit === 'UNIDAD' ? (material.looseStock === 1 ? 'unidad' : 'unidades') : material.unit.toLowerCase()} de ${name} en stock, pero ninguna está registrada como tabla física con medidas; el plano de corte solo usa piezas físicas.`
      : `${name} no tiene tablas ni retazos físicos registrados.`;
    return { funnel, reason: 'NO_PHYSICAL_STOCK', details };
  }
  if (!available.length) {
    const breakdown = stateBreakdown(material.piecesByState);
    return material.reservedPieces
      ? { funnel, reason: 'STOCK_RESERVED', details: `${name} tiene ${plural(material.physicalPieces, 'pieza física', 'piezas físicas')}, pero ninguna está disponible (${breakdown}).` }
      : { funnel, reason: 'NO_AVAILABLE_STOCK', details: `${name} tiene ${plural(material.physicalPieces, 'pieza física', 'piezas físicas')}, pero ninguna está disponible (${breakdown}).` };
  }
  if (!sameThickness.length) {
    return { funnel, reason: 'THICKNESS_MISMATCH', details: `La pieza requiere ${part.thicknessMm} mm de alto; ${available.length === 1 ? 'la pieza disponible' : `las ${available.length} piezas disponibles`} de ${name} ${available.length === 1 ? 'tiene' : 'tienen'} ${material.availableThicknessesMm.join(' / ')} mm.` };
  }
  if (!compatible.length) {
    const largest = [...sameThickness].sort((a, b) => area(b.lengthMm, b.widthMm) - area(a.lengthMm, a.widthMm))[0];
    return { funnel, reason: 'DIMENSIONS_TOO_LARGE', details: `La pieza mide ${part.lengthMm} × ${part.widthMm} mm y no cabe${part.canRotate ? ' ni girada' : ''} en ninguna pieza disponible de ${part.thicknessMm} mm; la mayor es ${largest.code} (${largest.lengthMm} × ${largest.widthMm} mm).` };
  }
  return { funnel, reason: null, details: '' };
}

export function suggestCuts(
  requirements: CutRequirement[],
  boards: CutBoard[],
  kerfMm: number,
  strategy: CutStrategy,
  stock?: MaterialStockContext[],
): CuttingResult {
  if (!Number.isInteger(kerfMm) || kerfMm < 0 || kerfMm > MAX_KERF_MM) throw new Error('Kerf inválido.');
  for (const board of boards) {
    if (![board.lengthMm, board.widthMm, board.thicknessMm].every(validDimension)) throw new Error(`Dimensiones inválidas para ${board.code}.`);
  }
  const parts = expandedParts(requirements);
  const { planned, pending } = nest(parts, boards, kerfMm, strategy);
  const materials = materialDiagnostics(requirements, boards, stock);

  // Distingue "no entra por el corte de sierra" de "no queda espacio": se repite el anidado con kerf 0
  // y, por requerimiento, las piezas que ahí sí se ubican se atribuyen al kerf.
  const placedBy = (plan: PlannedBoard[]) => {
    const counts = new Map<string, number>();
    for (const board of plan) for (const placement of board.placements) {
      const requirementId = placement.requirementId.slice(0, placement.requirementId.lastIndexOf(':'));
      counts.set(requirementId, (counts.get(requirementId) ?? 0) + 1);
    }
    return counts;
  };
  const placed = placedBy(planned);
  const placedWithoutKerf = kerfMm > 0 && pending.length ? placedBy(nest(parts, boards, 0, strategy).planned) : placed;
  const kerfBudget = new Map([...placedWithoutKerf].map(([id, count]) => [id, Math.max(0, count - (placed.get(id) ?? 0))]));

  const funnels = new Map<string, CandidateFunnel>();
  const unplaced: UnplacedPart[] = pending.map((part) => {
    const material = materials.get(part.materialId)!;
    const check = precheck(part, material, boards);
    funnels.set(part.requirementId, check.funnel);
    let reason: UnplacedReason = check.reason ?? 'UNKNOWN';
    let reasonDetails = check.details;
    if (!check.reason) {
      const budget = kerfBudget.get(part.requirementId) ?? 0;
      if (budget > 0) {
        kerfBudget.set(part.requirementId, budget - 1);
        reason = 'KERF_NO_FIT';
        reasonDetails = `La pieza cabría si el corte de sierra fuese 0 mm, pero con ${kerfMm} mm de corte ya no entra en el espacio restante de las piezas de ${material.materialName}.`;
      } else {
        reason = 'INSUFFICIENT_REMAINING_SPACE';
        reasonDetails = `La pieza cabe en una tabla vacía, pero las piezas disponibles de ${part.thicknessMm} mm de ${material.materialName} se ocuparon con otras piezas; faltan tablas o retazos.`;
      }
    }
    return {
      id: part.id, requirementId: part.requirementId, label: part.label, materialId: part.materialId,
      lengthMm: part.lengthMm, widthMm: part.widthMm, thicknessMm: part.thicknessMm, reason, reasonDetails,
    };
  });

  const groups: UnplacedGroup[] = [];
  for (const part of unplaced) {
    const existing = groups.find((group) => group.requirementId === part.requirementId && group.reason === part.reason);
    if (existing) { existing.pending += 1; continue; }
    const requirement = requirements.find((entry) => entry.id === part.requirementId)!;
    groups.push({
      requirementId: part.requirementId, label: part.label, materialId: part.materialId,
      materialName: materials.get(part.materialId)!.materialName,
      lengthMm: part.lengthMm, widthMm: part.widthMm, thicknessMm: part.thicknessMm,
      requested: requirement.quantity, placed: placed.get(part.requirementId) ?? 0, pending: 1,
      reason: part.reason, reasonDetails: part.reasonDetails, funnel: funnels.get(part.requirementId)!,
    });
  }
  const reasonTotals = new Map<UnplacedReason, number>();
  for (const part of unplaced) reasonTotals.set(part.reason, (reasonTotals.get(part.reason) ?? 0) + 1);
  const primaryReason = [...reasonTotals].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;

  const placedCount = planned.reduce((sum, board) => sum + board.placements.length, 0);
  const totalArea = planned.reduce((sum, board) => sum + area(board.lengthMm, board.widthMm), 0);
  const usedArea = planned.reduce((sum, board) => sum + board.placements.reduce((pieceArea, piece) => pieceArea + area(piece.lengthMm, piece.widthMm), 0), 0);
  return {
    strategy,
    kerfMm,
    boards: planned,
    unplaced,
    diagnostics: {
      requestedParts: parts.length,
      placedParts: placedCount,
      unplacedParts: unplaced.length,
      primaryReason,
      materials: [...materials.values()],
      groups,
    },
    summary: {
      requestedParts: parts.length,
      placedParts: placedCount,
      boardsUsed: planned.length,
      cutsEstimated: planned.reduce((sum, board) => sum + board.cutsEstimated, 0),
      totalAreaMm2: totalArea,
      usedAreaMm2: usedArea,
      wasteAreaMm2: planned.reduce((sum, board) => sum + board.wasteAreaMm2, 0),
      utilizationPercent: totalArea ? Number(((usedArea / totalArea) * 100).toFixed(1)) : 0,
    },
  };
}
