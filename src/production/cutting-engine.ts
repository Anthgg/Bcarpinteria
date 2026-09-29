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

export interface CuttingResult {
  strategy: CutStrategy;
  kerfMm: number;
  boards: PlannedBoard[];
  unplaced: Array<{ label: string; materialId: string; lengthMm: number; widthMm: number; thicknessMm: number }>;
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

export function suggestCuts(
  requirements: CutRequirement[],
  boards: CutBoard[],
  kerfMm: number,
  strategy: CutStrategy,
): CuttingResult {
  if (!Number.isInteger(kerfMm) || kerfMm < 0 || kerfMm > 100) throw new Error('Kerf inválido.');
  for (const board of boards) {
    if (![board.lengthMm, board.widthMm, board.thicknessMm].every(validDimension)) throw new Error(`Dimensiones inválidas para ${board.code}.`);
  }
  let pending = expandedParts(requirements);
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
  const placedCount = planned.reduce((sum, board) => sum + board.placements.length, 0);
  const totalArea = planned.reduce((sum, board) => sum + area(board.lengthMm, board.widthMm), 0);
  const usedArea = planned.reduce((sum, board) => sum + board.placements.reduce((pieceArea, piece) => pieceArea + area(piece.lengthMm, piece.widthMm), 0), 0);
  return {
    strategy,
    kerfMm,
    boards: planned,
    unplaced: pending.map(({ label, materialId, lengthMm, widthMm, thicknessMm }) => ({ label, materialId, lengthMm, widthMm, thicknessMm })),
    summary: {
      requestedParts: expandedParts(requirements).length,
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
