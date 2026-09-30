import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { AppRole, ItemType, OrderLineType, OrderStatus, PaymentStatus, PieceState, Prisma, ReservationStatus } from '@prisma/client';
import { hash } from 'bcryptjs';
import ExcelJS from 'exceljs';
import { randomBytes } from 'node:crypto';
import { PrismaService } from '../prisma.service';
import { AuthUser } from '../common/auth';
import { parseMoneyCents } from '../common/money';
import { calculateOrderTotals } from '../orders/pricing';
import { MAX_KERF_MM } from '../production/cutting-engine';
import { INVENTORY_UNITS, normalizeInventoryUnit } from '../common/units';

type JsonRecord = Record<string, unknown>;
const ROLE_VALUES = Object.values(AppRole);
const ITEM_TYPES = Object.values(ItemType);
const moneyCents = (value: unknown, label: string): number => {
  const cents = parseMoneyCents(value);
  if (cents === undefined) {
    throw new BadRequestException(`${label} debe estar dentro del rango monetario permitido.`);
  }
  return cents;
};
const optionalDate = (value: unknown, label: string): Date | null => {
  if (value === undefined || value === null || value === '') return null;
  const date = new Date(String(value));
  if (!Number.isFinite(date.getTime())) throw new BadRequestException(`${label} no es una fecha válida.`);
  return date;
};
const isJsonRecord = (value: unknown): value is JsonRecord =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const positive = (value: unknown, label: string): number => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) throw new BadRequestException(`${label} debe ser mayor que cero.`);
  return parsed;
};
const positiveMillimeters = (value: unknown, label: string): number => {
  const millimeters = Number(value);
  if (!Number.isSafeInteger(millimeters) || millimeters < 1 || millimeters > 10_000_000) throw new BadRequestException(`${label} debe ser un entero entre 1 y 10000000 mm.`);
  return millimeters;
};
const booleanInput = (value: unknown, label: string, fallback = false): boolean => {
  if (value === undefined) return fallback;
  if (typeof value !== 'boolean') throw new BadRequestException(`${label} debe ser verdadero o falso.`);
  return value;
};
const optionalText = (value: unknown, max = 1000) => {
  if (value === undefined || value === null || value === '') return null;
  const text = String(value).trim();
  if (text.length > max) throw new BadRequestException(`El texto excede ${max} caracteres.`);
  return text || null;
};
const cleanEmail = (value: unknown) => {
  if (value === undefined || value === null || value === '') return null;
  const email = String(value).trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) {
    throw new BadRequestException('Ingresa un correo válido.');
  }
  return email;
};
const normalizeHeader = (value: unknown) => String(value ?? '')
  .normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim().toLowerCase().replace(/\s+/g, ' ');
const cellValue = (value: ExcelJS.CellValue): unknown => {
  if (value && typeof value === 'object') {
    if ('result' in value) return value.result;
    if ('richText' in value) return value.richText.map((part) => part.text).join('');
    if ('text' in value) return value.text;
  }
  return value;
};

@Injectable()
export class CoreService {
  constructor(private readonly prisma: PrismaService) {}

  async audit(userId: string | null, action: string, entity: string, entityId?: string, metadata?: Prisma.InputJsonValue) {
    await this.prisma.auditLog.create({
      data: { userId, action, entity, entityId, metadata },
    });
  }

  async listUsers() {
    return this.prisma.user.findMany({
      select: { id: true, email: true, name: true, role: true, active: true, createdAt: true },
      orderBy: { createdAt: 'desc' },
    });
  }

  async createUser(actor: AuthUser, input: JsonRecord) {
    const email = cleanEmail(input.email);
    const name = String(input.name ?? '').trim();
    const password = String(input.password ?? '');
    const role = String(input.role ?? 'OPERARIO') as AppRole;
    if (!email || name.length < 2 || name.length > 120) throw new BadRequestException('Completa el nombre y correo.');
    if (password.length < 12 || password.length > 128) throw new BadRequestException('La contraseña debe tener entre 12 y 128 caracteres.');
    if (!ROLE_VALUES.includes(role)) throw new BadRequestException('El rol no es válido.');
    try {
      const user = await this.prisma.user.create({
        data: { email, name, role, passwordHash: await hash(password, 12) },
        select: { id: true, email: true, name: true, role: true, active: true, createdAt: true },
      });
      await this.audit(actor.id, 'USER_CREATED', 'User', user.id, { role });
      return user;
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new ConflictException('Ya existe una cuenta con ese correo.');
      }
      throw error;
    }
  }

  async updateUser(actor: AuthUser, id: string, input: JsonRecord) {
    const data: Prisma.UserUpdateInput = {};
    if (input.name !== undefined) {
      const name = String(input.name).trim();
      if (name.length < 2 || name.length > 120) throw new BadRequestException('El nombre debe tener entre 2 y 120 caracteres.');
      data.name = name;
    }
    if (input.email !== undefined) {
      const email = cleanEmail(input.email);
      if (!email) throw new BadRequestException('Correo inválido.');
      data.email = email;
    }
    if (input.role !== undefined) {
      const role = String(input.role) as AppRole;
      if (!ROLE_VALUES.includes(role)) throw new BadRequestException('El rol no es válido.');
      data.role = role;
    }
    if (input.active !== undefined) {
      if (typeof input.active !== 'boolean') throw new BadRequestException('El estado activo debe ser verdadero o falso.');
      data.active = input.active;
    }
    if (input.password !== undefined) {
      const password = String(input.password);
      if (password.length < 12 || password.length > 128) throw new BadRequestException('La contraseña debe tener entre 12 y 128 caracteres.');
      data.passwordHash = await hash(password, 12);
    }
    const user = await this.prisma.$transaction(async (tx) => {
      const current = await tx.user.findUnique({ where: { id } });
      if (!current) throw new NotFoundException('Usuario no encontrado.');
      const nextRole = (data.role as AppRole | undefined) ?? current.role;
      const nextActive = (data.active as boolean | undefined) ?? current.active;
      if (current.role === AppRole.ADMIN && current.active && (nextRole !== AppRole.ADMIN || !nextActive)) {
        const activeAdmins = await tx.user.count({ where: { role: AppRole.ADMIN, active: true } });
        if (activeAdmins <= 1) throw new ConflictException('Debe quedar al menos un administrador activo.');
      }
      const updated = await tx.user.update({
        where: { id }, data,
        select: { id: true, email: true, name: true, role: true, active: true, createdAt: true },
      });
      const credentialsChanged = data.active === false || data.passwordHash !== undefined || data.email !== undefined || data.role !== undefined;
      if (credentialsChanged) await tx.session.updateMany({ where: { userId: id, revokedAt: null }, data: { revokedAt: new Date() } });
      return updated;
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    await this.audit(actor.id, 'USER_UPDATED', 'User', id, { role: user.role, active: user.active });
    return user;
  }

  async listInventory(search = '') {
    const items = await this.prisma.inventoryItem.findMany({
      where: { active: true, ...(search ? { name: { contains: search.trim(), mode: 'insensitive' } } : {}) },
      include: { _count: { select: { pieces: true } } },
      orderBy: [{ type: 'asc' }, { name: 'asc' }],
    });
    const ids = items.map((item) => item.id);
    const pieceCounts = ids.length ? await this.prisma.materialPiece.groupBy({
      by: ['materialId', 'state'], where: { materialId: { in: ids } }, _count: { _all: true },
    }) : [];
    return items.map((item) => ({
      ...item,
      stock: Number(item.stock),
      pieceCounts: Object.fromEntries(pieceCounts.filter((piece) => piece.materialId === item.id).map((piece) => [piece.state, piece._count._all])),
    }));
  }

  /**
   * Disponibilidad agregada para los selectores de producción (solo lectura, consultas fijas sin N+1).
   * Consumibles: `stock` ya es neto de reservas (reservar descuenta stock y crea ItemReservation).
   * Maderas: solo MaterialPiece AVAILABLE cuenta como utilizable por el plano de corte.
   */
  async listMaterialAvailability() {
    const items = await this.prisma.inventoryItem.findMany({
      where: { active: true, OR: [{ type: ItemType.MATERIAL }, { productionConsumable: true }] },
      select: { id: true, code: true, name: true, type: true, unit: true, stock: true, controlsStock: true, productionConsumable: true, requiresDimensions: true },
      orderBy: { name: 'asc' },
    });
    const ids = items.map((item) => item.id);
    const [counts, available, reservations, threshold] = ids.length ? await Promise.all([
      this.prisma.materialPiece.groupBy({ by: ['materialId', 'state'], where: { materialId: { in: ids } }, _count: { _all: true } }),
      this.prisma.materialPiece.findMany({
        where: { materialId: { in: ids }, state: PieceState.AVAILABLE },
        select: { materialId: true, code: true, kind: true, lengthMm: true, widthMm: true, thicknessMm: true },
      }),
      this.prisma.itemReservation.groupBy({ by: ['itemId'], where: { itemId: { in: ids }, status: ReservationStatus.RESERVED }, _sum: { quantity: true } }),
      this.prisma.appSetting.findUnique({ where: { key: 'low_stock_threshold' } }),
    ]) : [[], [], [], null] as const;
    return {
      lowStockThreshold: Number(threshold?.value ?? 5),
      items: items.map((item) => {
        const pieces = available.filter((piece) => piece.materialId === item.id);
        const piecesByState = Object.fromEntries(counts.filter((row) => row.materialId === item.id).map((row) => [row.state, row._count._all]));
        const largest = [...pieces].sort((a, b) => b.lengthMm * b.widthMm - a.lengthMm * a.widthMm)[0];
        return {
          ...item,
          stock: Number(item.stock),
          reservedQuantity: Number(reservations.find((row) => row.itemId === item.id)?._sum.quantity ?? 0),
          piecesByState,
          physicalPieces: Object.values(piecesByState).reduce((sum, count) => sum + count, 0),
          availablePieces: pieces.length,
          reservedPieces: piecesByState[PieceState.RESERVED] ?? 0,
          availableThicknessesMm: [...new Set(pieces.map((piece) => piece.thicknessMm))].sort((a, b) => a - b),
          largestAvailablePiece: largest ? { code: largest.code, kind: largest.kind, lengthMm: largest.lengthMm, widthMm: largest.widthMm, thicknessMm: largest.thicknessMm } : null,
        };
      }),
    };
  }

  async createInventoryItem(actor: AuthUser, input: JsonRecord) {
    const name = String(input.name ?? '').trim();
    const type = String(input.type ?? 'MATERIAL') as ItemType;
    if (name.length < 2 || name.length > 160) throw new BadRequestException('El nombre debe tener entre 2 y 160 caracteres.');
    if (!ITEM_TYPES.includes(type)) throw new BadRequestException('Tipo de artículo inválido.');
    const dimensions = ['lengthMm', 'widthMm', 'thicknessMm'] as const;
    const normalizedDimensions = Object.fromEntries(dimensions.map((field) => [field, input[field] == null || input[field] === '' ? null : positiveMillimeters(input[field], field)])) as Record<typeof dimensions[number], number | null>;
    const requiresDimensions = booleanInput(input.requiresDimensions, 'Requiere dimensiones');
    if (requiresDimensions && dimensions.some((field) => !normalizedDimensions[field])) throw new BadRequestException('Un material dimensional requiere largo, ancho y espesor en mm.');
    const initialStock = Number(input.stock ?? 0);
    if (!Number.isFinite(initialStock) || initialStock < 0 || initialStock > 99999999999.999) throw new BadRequestException('El stock inicial debe estar dentro del rango permitido.');
    const unit = normalizeInventoryUnit(input.unit ?? 'UNIDAD');
    if (!unit) throw new BadRequestException('Unidad de inventario no válida.');
    const item = await this.prisma.inventoryItem.create({
      data: {
        code: `SKU-${randomBytes(5).toString('hex').toUpperCase()}`,
        name,
        description: optionalText(input.description),
        type,
        unit,
        stock: new Prisma.Decimal(initialStock),
        unitPriceCents: moneyCents(input.unitPrice ?? 0, 'Precio unitario'),
        sellable: booleanInput(input.sellable, 'Vendible'),
        controlsStock: booleanInput(input.controlsStock, 'Controla stock', true),
        productionConsumable: booleanInput(input.productionConsumable, 'Consumible de producción'),
        requiresDimensions,
        active: true,
        ...normalizedDimensions,
      },
    });
    await this.audit(actor.id, 'INVENTORY_ITEM_CREATED', 'InventoryItem', item.id, { type });
    return { ...item, stock: Number(item.stock) };
  }

  async updateInventoryItem(actor: AuthUser, id: string, input: JsonRecord) {
    const current = await this.prisma.inventoryItem.findUnique({ where: { id } });
    if (!current) throw new NotFoundException('Artículo no encontrado.');
    const data: Prisma.InventoryItemUpdateInput = {};
    if (input.name !== undefined) {
      const name = String(input.name).trim();
      if (name.length < 2 || name.length > 160) throw new BadRequestException('El nombre debe tener entre 2 y 160 caracteres.');
      data.name = name;
    }
    if (input.description !== undefined) data.description = optionalText(input.description);
    if (input.type !== undefined) {
      const type = String(input.type) as ItemType;
      if (!ITEM_TYPES.includes(type)) throw new BadRequestException('Tipo de artículo inválido.');
      data.type = type;
    }
    if (input.unit !== undefined) {
      const unit = normalizeInventoryUnit(input.unit);
      if (!unit) throw new BadRequestException('Unidad de inventario no válida.');
      data.unit = unit;
    }
    if (input.unitPrice !== undefined) data.unitPriceCents = moneyCents(input.unitPrice, 'Precio unitario');
    if (input.sellable !== undefined) data.sellable = booleanInput(input.sellable, 'Vendible');
    if (input.controlsStock !== undefined) data.controlsStock = booleanInput(input.controlsStock, 'Controla stock');
    if (input.productionConsumable !== undefined) data.productionConsumable = booleanInput(input.productionConsumable, 'Consumible de producción');
    if (input.active !== undefined) data.active = booleanInput(input.active, 'Activo');
    if (input.requiresDimensions !== undefined) data.requiresDimensions = booleanInput(input.requiresDimensions, 'Requiere dimensiones');
    for (const [field, dataField] of [['lengthMm', 'lengthMm'], ['widthMm', 'widthMm'], ['thicknessMm', 'thicknessMm']] as const) {
      if (input[field] !== undefined) data[dataField] = input[field] === null || input[field] === '' ? null : positiveMillimeters(input[field], field);
    }
    const requiresDimensions = booleanInput(input.requiresDimensions, 'Requiere dimensiones', current.requiresDimensions);
    const dimensions = {
      lengthMm: input.lengthMm === undefined ? current.lengthMm : data.lengthMm,
      widthMm: input.widthMm === undefined ? current.widthMm : data.widthMm,
      thicknessMm: input.thicknessMm === undefined ? current.thicknessMm : data.thicknessMm,
    };
    if (requiresDimensions && Object.values(dimensions).some((value) => !value || typeof value !== 'number')) {
      throw new BadRequestException('Un material dimensional requiere largo, ancho y espesor en mm.');
    }
    const item = await this.prisma.inventoryItem.update({ where: { id }, data });
    await this.audit(actor.id, 'INVENTORY_ITEM_UPDATED', 'InventoryItem', id, { changedFields: Object.keys(input) });
    return { ...item, stock: Number(item.stock) };
  }

  async adjustStock(actor: AuthUser, id: string, deltaValue: unknown, note?: unknown) {
    const delta = Number(deltaValue);
    if (!Number.isFinite(delta) || delta === 0 || Math.abs(delta) > 1_000_000) throw new BadRequestException('El movimiento debe ser distinto de cero y válido.');
    return this.prisma.$transaction(async (tx) => {
      const item = await tx.inventoryItem.findUnique({ where: { id } });
      if (!item) throw new NotFoundException('Artículo no encontrado.');
      if (!item.controlsStock) throw new BadRequestException('El artículo no controla existencias.');
      const updatedStock = Number(item.stock) + delta;
      if (updatedStock < 0) throw new ConflictException('El movimiento dejaría el stock negativo.');
      await tx.inventoryItem.update({ where: { id }, data: { stock: new Prisma.Decimal(updatedStock) } });
      await tx.inventoryMovement.create({
        data: { itemId: id, quantity: new Prisma.Decimal(Math.abs(delta)), action: delta > 0 ? 'STOCK_IN' : 'STOCK_OUT', note: optionalText(note, 500), userId: actor.id },
      });
      await tx.auditLog.create({ data: { userId: actor.id, action: 'STOCK_ADJUSTED', entity: 'InventoryItem', entityId: id, metadata: { delta } } });
      return { id, stock: updatedStock };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  }

  async listPieces(itemId?: string) {
    return this.prisma.materialPiece.findMany({
      where: itemId ? { materialId: itemId } : {},
      include: { material: { select: { id: true, code: true, name: true } }, originPiece: { select: { id: true, code: true } } },
      orderBy: { createdAt: 'desc' },
    });
  }

  async listMovements() {
    return this.prisma.inventoryMovement.findMany({
      take: 100,
      include: { item: { select: { code: true, name: true, unit: true } }, piece: { select: { code: true, state: true, material: { select: { name: true } } } } },
      orderBy: { createdAt: 'desc' },
    });
  }

  async setPieceState(actor: AuthUser, id: string, stateValue: unknown, note?: unknown) {
    const state = String(stateValue);
    if (!['AVAILABLE', 'DISCARDED'].includes(state)) throw new BadRequestException('Selecciona conservar o descartar la pieza.');
    return this.prisma.$transaction(async (tx) => {
      const piece = await tx.materialPiece.findUnique({ where: { id } });
      if (!piece) throw new NotFoundException('Pieza física no encontrada.');
      const pendingOffcut = piece.kind === 'OFFCUT' && piece.state === 'PENDING_DISPOSITION';
      if (!pendingOffcut && !['AVAILABLE', 'DISCARDED'].includes(piece.state)) throw new ConflictException('Una pieza reservada o consumida no se puede cambiar.');
      if (piece.state === state) return piece;
      const updated = await tx.materialPiece.update({ where: { id }, data: { state: state as 'AVAILABLE' | 'DISCARDED' } });
      await tx.inventoryMovement.create({ data: { pieceId: id, itemId: piece.materialId, action: state === 'DISCARDED' ? 'PIECE_DISCARDED' : 'PIECE_RESTORED', note: optionalText(note, 500), userId: actor.id } });
      await tx.auditLog.create({ data: { userId: actor.id, action: state === 'DISCARDED' ? 'PIECE_DISCARDED' : 'PIECE_RESTORED', entity: 'MaterialPiece', entityId: id } });
      return updated;
    });
  }

  async createPiece(actor: AuthUser, input: JsonRecord) {
    const materialId = String(input.materialId ?? '');
    const lengthMm = positiveMillimeters(input.lengthMm, 'Largo');
    const widthMm = positiveMillimeters(input.widthMm, 'Ancho');
    const thicknessMm = positiveMillimeters(input.thicknessMm, 'Espesor');
    const fromExistingStock = booleanInput(input.fromExistingStock, 'Convertir stock existente');
    return this.prisma.$transaction(async (tx) => {
      const item = await tx.inventoryItem.findUnique({ where: { id: materialId } });
      if (!item || item.type !== ItemType.MATERIAL) throw new NotFoundException('Selecciona un material existente.');
      if (fromExistingStock) {
        const taken = await tx.inventoryItem.updateMany({ where: { id: materialId, stock: { gte: 1 } }, data: { stock: { decrement: 1 } } });
        if (taken.count !== 1) throw new ConflictException('No hay una unidad suelta disponible para convertir en pieza física.');
      }
      const sequence = await tx.numberSequence.upsert({ where: { name: 'piece' }, create: { name: 'piece', value: 1 }, update: { value: { increment: 1 } } });
      const piece = await tx.materialPiece.create({
        data: {
          code: `TAB-${String(sequence.value).padStart(5, '0')}`,
          materialId, lengthMm, widthMm, thicknessMm,
          kind: 'BOARD',
        },
      });
      await tx.inventoryMovement.create({ data: { itemId: materialId, pieceId: piece.id, quantity: 1, action: 'PIECE_CREATED', note: fromExistingStock ? 'Convertida de stock suelto' : 'Nueva pieza física', userId: actor.id } });
      await tx.auditLog.create({ data: { userId: actor.id, action: 'PIECE_CREATED', entity: 'MaterialPiece', entityId: piece.id } });
      return piece;
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  }

  private async readWorkbook() {
    const file = process.env.BD_PATH ?? './bd/inventario g.xlsx';
    const workbook = new ExcelJS.Workbook();
    try {
      await workbook.xlsx.readFile(file);
    } catch {
      throw new NotFoundException(`No se pudo leer el Excel configurado: ${file}`);
    }
    const sheet = workbook.worksheets[0];
    if (!sheet) throw new BadRequestException('El Excel no contiene hojas.');
    const header = sheet.getRow(1).values as ExcelJS.CellValue[];
    const columns = header.slice(1).map((cell) => normalizeHeader(cellValue(cell)));
    const required = ['id', 'material', 'unidad', 'stock', 'precio unitario'];
    const missing = required.filter((column) => !columns.includes(column));
    if (missing.length) throw new BadRequestException(`Faltan columnas obligatorias: ${missing.join(', ')}.`);
    const duplicated = required.filter((column) => columns.filter((candidate) => candidate === column).length > 1);
    if (duplicated.length) throw new BadRequestException(`Hay columnas obligatorias duplicadas: ${duplicated.join(', ')}.`);
    const indexes = Object.fromEntries(required.map((key) => [key, columns.indexOf(key) + 1]));
    const rows: Array<{ row: number; legacyId: string; name: string; unit: string; stock: number; unitPriceCents: number; error?: string }> = [];
    const ids = new Set<string>();
    const names = new Set<string>();
    sheet.eachRow((row, rowNumber) => {
      if (rowNumber === 1) return;
      const read = (field: string) => cellValue(row.getCell(indexes[field]).value);
      const rawId = read('id');
      const rawName = read('material');
      const rawUnit = read('unidad');
      const stockCell = read('stock');
      const priceCell = read('precio unitario');
      const rawStock = Number(stockCell);
      const unitPriceCents = parseMoneyCents(priceCell);
      if (rawId == null && !rawName) return;
      const legacyId = String(rawId ?? '').trim();
      const name = String(rawName ?? '').trim();
      // El Excel se mapea al catálogo controlado; una unidad desconocida queda como error de fila, nunca se crea.
      const rawUnitText = String(rawUnit ?? '').trim();
      const unit = normalizeInventoryUnit(rawUnitText) ?? rawUnitText.toUpperCase();
      const unitKnown = normalizeInventoryUnit(rawUnitText) !== null;
      const normalizedName = normalizeHeader(name);
      const error = !legacyId ? 'ID vacío.' : legacyId.length > 100 ? 'El ID excede 100 caracteres.'
        : ids.has(legacyId) ? 'ID duplicado dentro del archivo.'
        : name.length < 2 || name.length > 160 ? 'El nombre debe tener entre 2 y 160 caracteres.'
        : names.has(normalizedName) ? 'Material duplicado dentro del archivo.'
        : stockCell == null || String(stockCell).trim() === '' || !Number.isFinite(rawStock) || rawStock < 0 || rawStock > 99999999999.999 ? 'Stock debe ser numérico, no negativo y estar dentro del rango permitido.'
        : Math.abs(rawStock * 1000 - Math.round(rawStock * 1000)) > 1e-7 ? 'Stock admite hasta tres decimales.'
        : unitPriceCents === undefined ? 'Precio unitario debe estar dentro del rango monetario permitido.'
        : !rawUnitText ? 'Unidad vacía.'
        : !unitKnown ? `Unidad no reconocida: «${rawUnitText.slice(0, 30)}». Usa una del catálogo (${INVENTORY_UNITS.map((entry) => entry.code).join(', ')}).` : undefined;
      if (legacyId) ids.add(legacyId);
      if (normalizedName) names.add(normalizedName);
      rows.push({ row: rowNumber, legacyId, name, unit, stock: rawStock, unitPriceCents: unitPriceCents ?? 0, ...(error ? { error } : {}) });
    });
    if (!rows.length) throw new BadRequestException('El Excel no contiene filas de inventario.');
    const existing = await this.prisma.inventoryItem.findMany({
      where: { OR: rows.filter((row) => !row.error).flatMap((row) => [{ legacyId: row.legacyId }, { name: { equals: row.name, mode: 'insensitive' } }]) },
      select: { legacyId: true, name: true },
    });
    const existingIds = new Set(existing.map((item) => item.legacyId).filter((id): id is string => id !== null));
    const existingNames = new Set(existing.map((item) => normalizeHeader(item.name)));
    const annotated = rows.map((row) => ({
      ...row,
      ...(row.error ? {} : existingIds.has(row.legacyId) || existingNames.has(normalizeHeader(row.name)) ? { duplicate: true } : {}),
    }));
    return { file, sheet: sheet.name, rows: annotated, valid: annotated.filter((row) => !row.error).length, invalid: annotated.filter((row) => !!row.error).length, duplicates: annotated.filter((row) => row.duplicate).length };
  }

  async previewImport() {
    const report = await this.readWorkbook();
    return { source: report.file.split(/[\\/]/).at(-1), sheet: report.sheet, validRows: report.valid, invalidRows: report.invalid, existingRows: report.duplicates, rows: report.rows };
  }

  async importWorkbook(actor: AuthUser) {
    const report = await this.readWorkbook();
    if (report.invalid) throw new BadRequestException({ message: 'Corrige los errores de validación antes de importar.', rows: report.rows.filter((row) => row.error) });
    const result = await this.prisma.$transaction(async (tx) => {
      let imported = 0;
      let skipped = 0;
      for (const row of report.rows) {
        const existing = await tx.inventoryItem.findFirst({
          where: { OR: [{ legacyId: row.legacyId }, { name: { equals: row.name, mode: 'insensitive' } }] },
          select: { id: true },
        });
        if (existing) { skipped += 1; continue; }
        const upper = row.name.toLocaleUpperCase('es-PE');
        const isTool = /SIERRA|TALADRO|ESCUADRA|CINTA METRICA|LLAVES/.test(upper);
        const isConsumable = /BARNIZ|COLA|PEGAMENTO|TORNILLO|CLAVO|LIJA|TIRADOR|CORREDERA/.test(upper);
        await tx.inventoryItem.create({
          data: {
            code: `XLS-${row.legacyId}`,
            legacyId: row.legacyId,
            name: row.name,
            type: isTool ? ItemType.HERRAMIENTA : isConsumable ? ItemType.CONSUMIBLE : ItemType.MATERIAL,
            unit: row.unit,
            stock: new Prisma.Decimal(row.stock),
            unitPriceCents: row.unitPriceCents,
            controlsStock: true,
            productionConsumable: !isTool,
          },
        });
        imported += 1;
      }
      await tx.auditLog.create({
        data: { userId: actor.id, action: 'INVENTORY_IMPORTED', entity: 'InventoryItem', metadata: { imported, skipped, rows: report.rows.length, source: report.file.split(/[\\/]/).at(-1) } },
      });
      return { imported, skipped, total: report.rows.length };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    return result;
  }

  async listCustomers(search = '') {
    return this.prisma.customer.findMany({
      where: { active: true, ...(search ? { OR: [
        { name: { contains: search.trim(), mode: 'insensitive' } },
        { documentNumber: { contains: search.trim(), mode: 'insensitive' } },
        { phone: { contains: search.trim(), mode: 'insensitive' } },
      ] } : {}) },
      orderBy: { name: 'asc' },
    });
  }

  async createCustomer(actor: AuthUser, input: JsonRecord) {
    const name = String(input.name ?? '').trim();
    if (name.length < 2 || name.length > 180) throw new BadRequestException('El nombre debe tener entre 2 y 180 caracteres.');
    const documentType = String(input.documentType ?? 'OTRO').toUpperCase();
    const documentNumber = optionalText(input.documentNumber, 40);
    try {
      const customer = await this.prisma.customer.create({ data: {
        name, documentType, documentNumber,
        phone: optionalText(input.phone, 40), email: cleanEmail(input.email),
        address: optionalText(input.address, 300), notes: optionalText(input.notes),
      } });
      await this.audit(actor.id, 'CUSTOMER_CREATED', 'Customer', customer.id);
      return customer;
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') throw new ConflictException('Ya existe un cliente con ese tipo y número de documento.');
      throw error;
    }
  }

  async updateCustomer(actor: AuthUser, id: string, input: JsonRecord) {
    const current = await this.prisma.customer.findUnique({ where: { id } });
    if (!current) throw new NotFoundException('Cliente no encontrado.');
    const data: Prisma.CustomerUpdateInput = {};
    if (input.name !== undefined) {
      const name = String(input.name).trim();
      if (name.length < 2 || name.length > 160) throw new BadRequestException('El nombre debe tener entre 2 y 160 caracteres.');
      data.name = name;
    }
    if (input.documentType !== undefined) data.documentType = String(input.documentType).toUpperCase();
    if (input.documentNumber !== undefined) data.documentNumber = optionalText(input.documentNumber, 40);
    if (input.phone !== undefined) data.phone = optionalText(input.phone, 40);
    if (input.email !== undefined) data.email = cleanEmail(input.email);
    if (input.address !== undefined) data.address = optionalText(input.address, 300);
    if (input.notes !== undefined) data.notes = optionalText(input.notes);
    const customer = await this.prisma.customer.update({ where: { id }, data });
    await this.audit(actor.id, 'CUSTOMER_UPDATED', 'Customer', id);
    return customer;
  }

  async archiveCustomer(actor: AuthUser, id: string) {
    const current = await this.prisma.customer.findUnique({ where: { id } });
    if (!current) throw new NotFoundException('Cliente no encontrado.');
    const customer = await this.prisma.customer.update({ where: { id }, data: { active: false } });
    await this.audit(actor.id, 'CUSTOMER_ARCHIVED', 'Customer', id);
    return { id: customer.id, active: customer.active };
  }

  async listProducts(search = '') {
    return this.prisma.product.findMany({
      where: { active: true, ...(search ? { name: { contains: search.trim(), mode: 'insensitive' } } : {}) },
      orderBy: [{ defaultProduct: 'desc' }, { name: 'asc' }],
    });
  }

  async createProduct(actor: AuthUser, input: JsonRecord) {
    const name = String(input.name ?? '').trim();
    if (name.length < 2 || name.length > 160) throw new BadRequestException('El nombre debe tener entre 2 y 160 caracteres.');
    const product = await this.prisma.product.create({ data: {
      code: optionalText(input.code, 40), name,
      description: optionalText(input.description),
      defaultProduct: booleanInput(input.defaultProduct, 'Producto predeterminado'),
    } });
    await this.audit(actor.id, 'PRODUCT_CREATED', 'Product', product.id);
    return product;
  }

  async updateProduct(actor: AuthUser, id: string, input: JsonRecord) {
    const current = await this.prisma.product.findUnique({ where: { id } });
    if (!current) throw new NotFoundException('Producto no encontrado.');
    const data: Prisma.ProductUpdateInput = {};
    if (input.name !== undefined) {
      const name = String(input.name).trim();
      if (name.length < 2 || name.length > 160) throw new BadRequestException('El nombre debe tener entre 2 y 160 caracteres.');
      data.name = name;
    }
    if (input.code !== undefined) data.code = optionalText(input.code, 40);
    if (input.description !== undefined) data.description = optionalText(input.description);
    if (input.defaultProduct !== undefined) data.defaultProduct = booleanInput(input.defaultProduct, 'Producto predeterminado');
    if (input.active !== undefined) data.active = booleanInput(input.active, 'Activo');
    const product = await this.prisma.product.update({ where: { id }, data });
    await this.audit(actor.id, 'PRODUCT_UPDATED', 'Product', id);
    return product;
  }

  async archiveProduct(actor: AuthUser, id: string) {
    const current = await this.prisma.product.findUnique({ where: { id } });
    if (!current) throw new NotFoundException('Producto no encontrado.');
    const product = await this.prisma.product.update({ where: { id }, data: { active: false } });
    await this.audit(actor.id, 'PRODUCT_ARCHIVED', 'Product', id);
    return { id: product.id, active: product.active };
  }

  async getSettings() {
    const values = await this.prisma.appSetting.findMany({ where: { key: { in: ['tax_rate_basis_points', 'cutting_kerf_mm', 'company_name', 'company_phone'] } } });
    const map = Object.fromEntries(values.map((setting) => [setting.key, setting.value]));
    return {
      taxRate: Number(map.tax_rate_basis_points ?? 1800) / 100,
      kerfMm: Number(map.cutting_kerf_mm ?? 3),
      companyName: map.company_name ?? 'Carpintería Ordenada 360°',
      companyPhone: map.company_phone ?? '',
    };
  }

  async updateSettings(actor: AuthUser, input: JsonRecord) {
    const updates: Array<[string, string]> = [];
    if (input.taxRate !== undefined) {
      const taxRate = Number(input.taxRate);
      if (!Number.isFinite(taxRate) || taxRate < 0 || taxRate > 100) throw new BadRequestException('IGV debe estar entre 0% y 100%.');
      updates.push(['tax_rate_basis_points', String(Math.round(taxRate * 100))]);
    }
    if (input.kerfMm !== undefined) {
      const kerf = Math.round(Number(input.kerfMm));
      if (!Number.isFinite(kerf) || kerf < 0 || kerf > MAX_KERF_MM) throw new BadRequestException(`El ancho de corte debe estar entre 0 y ${MAX_KERF_MM} mm.`);
      updates.push(['cutting_kerf_mm', String(kerf)]);
    }
    if (input.companyName !== undefined) updates.push(['company_name', String(input.companyName).trim().slice(0, 160)]);
    if (input.companyPhone !== undefined) updates.push(['company_phone', String(input.companyPhone).trim().slice(0, 40)]);
    await this.prisma.$transaction(updates.map(([key, value]) => this.prisma.appSetting.upsert({ where: { key }, create: { key, value }, update: { value } })));
    await this.audit(actor.id, 'SETTINGS_UPDATED', 'AppSetting', undefined, { keys: updates.map(([key]) => key) });
    return this.getSettings();
  }

  private async nextCode(tx: Prisma.TransactionClient, sequenceName: string, prefix: string) {
    const record = await tx.numberSequence.upsert({
      where: { name: sequenceName },
      create: { name: sequenceName, value: 1 },
      update: { value: { increment: 1 } },
    });
    return `${prefix}-${String(record.value).padStart(5, '0')}`;
  }

  async listOrders(search = '') {
    return this.prisma.order.findMany({
      where: search ? { OR: [
        { code: { contains: search.trim(), mode: 'insensitive' } },
        { customer: { name: { contains: search.trim(), mode: 'insensitive' } } },
      ] } : {},
      include: { customer: true, lines: { include: { product: true, item: true, job: { select: { id: true, stage: true, status: true, progress: true } } } }, payments: true },
      orderBy: { createdAt: 'desc' },
    });
  }

  async getOrder(id: string) {
    const order = await this.prisma.order.findFirst({
      where: { OR: [{ id }, { code: id }] },
      include: { customer: true, lines: { include: { product: true, item: true, job: true } }, payments: { orderBy: { paidAt: 'asc' } } },
    });
    if (!order) throw new NotFoundException('Pedido no encontrado.');
    return order;
  }

  async createOrder(actor: AuthUser, input: JsonRecord) {
    const customerId = String(input.customerId ?? '');
    if (!Array.isArray(input.lines) || !input.lines.length || input.lines.length > 100) throw new BadRequestException('Agrega entre 1 y 100 líneas al pedido.');
    if (input.lines.some((line) => !isJsonRecord(line))) throw new BadRequestException('Cada línea del pedido debe ser un objeto válido.');
    const customer = await this.prisma.customer.findUnique({ where: { id: customerId } });
    if (!customer || !customer.active) throw new NotFoundException('Selecciona un cliente activo.');
    const taxRateBasisPoints = Number((await this.prisma.appSetting.findUnique({ where: { key: 'tax_rate_basis_points' } }))?.value ?? 1800);
    const normalizedLines: Array<{
      type: OrderLineType; productId?: string; itemId?: string; name: string; description: string | null;
      lengthMm: number | null; widthMm: number | null; heightMm: number | null; quantity: number;
      unitPriceCents: number; discountCents: number; lineSubtotalCents: number;
    }> = [];
    for (const rawLine of input.lines as JsonRecord[]) {
      const type = String(rawLine.type ?? 'CUSTOM') as OrderLineType;
      if (!Object.values(OrderLineType).includes(type)) throw new BadRequestException('Tipo de línea inválido.');
      const quantity = Number(rawLine.quantity);
      if (!Number.isSafeInteger(quantity) || quantity < 1 || quantity > 10000) throw new BadRequestException('La cantidad debe ser un entero entre 1 y 10000.');
      let productId: string | undefined;
      let itemId: string | undefined;
      let name = String(rawLine.name ?? '').trim();
      if (type === OrderLineType.CATALOG) {
        const product = await this.prisma.product.findUnique({ where: { id: String(rawLine.productId ?? '') } });
        if (!product || !product.active) throw new NotFoundException('Producto de catálogo no encontrado.');
        productId = product.id;
        name = product.name;
      } else if (type === OrderLineType.MATERIAL) {
        const item = await this.prisma.inventoryItem.findUnique({ where: { id: String(rawLine.itemId ?? '') } });
        if (!item || !item.active || !item.sellable) throw new BadRequestException('El material debe existir y estar marcado como vendible.');
        itemId = item.id;
        name = item.name;
      }
      if (name.length < 2 || name.length > 160) throw new BadRequestException('El nombre de la línea debe tener entre 2 y 160 caracteres.');
      const unitPriceCents = moneyCents(rawLine.unitPrice, 'Precio unitario');
      const gross = quantity * unitPriceCents;
      const discountCents = moneyCents(rawLine.discount ?? 0, 'Descuento');
      if (discountCents > gross) throw new BadRequestException(`El descuento de ${name} supera su importe.`);
      const dimension = (field: string) => rawLine[field] == null || rawLine[field] === '' ? null : positiveMillimeters(rawLine[field], field);
      normalizedLines.push({
        type, productId, itemId, name,
        description: optionalText(rawLine.description),
        lengthMm: dimension('lengthMm'), widthMm: dimension('widthMm'), heightMm: dimension('heightMm'),
        quantity, unitPriceCents, discountCents, lineSubtotalCents: gross - discountCents,
      });
    }
    let totals;
    try {
      totals = calculateOrderTotals(normalizedLines, taxRateBasisPoints);
    } catch (error) {
      throw new BadRequestException((error as Error).message);
    }
    normalizedLines.forEach((line, index) => { line.lineSubtotalCents = totals.lines[index].lineSubtotalCents; });
    const { subtotalCents, discountCents, taxCents, totalCents } = totals;
    if ([subtotalCents, discountCents, taxCents, totalCents, ...totals.lines.map((line) => line.lineSubtotalCents)].some((value) => value > 2_147_483_647)) {
      throw new BadRequestException('El pedido excede el rango monetario permitido por la base de datos.');
    }
    const order = await this.prisma.$transaction(async (tx) => {
      const code = await this.nextCode(tx, 'order', 'PED');
      const created = await tx.order.create({ data: {
        code, customerId, status: OrderStatus.CONFIRMED,
        subtotalCents, discountCents, taxRateBasisPoints, taxCents, totalCents,
        trackingToken: randomBytes(32).toString('base64url'),
        estimatedAt: optionalDate(input.estimatedAt, 'La fecha estimada'),
        notes: optionalText(input.notes),
      }, include: { customer: true } });
      const materialQuantities = new Map<string, number>();
      for (const line of normalizedLines) {
        const createdLine = await tx.orderLine.create({ data: {
          orderId: created.id,
          type: line.type,
          productId: line.productId ?? null,
          itemId: line.itemId ?? null,
          name: line.name,
          description: line.description,
          lengthMm: line.lengthMm,
          widthMm: line.widthMm,
          heightMm: line.heightMm,
          quantity: line.quantity,
          unitPriceCents: line.unitPriceCents,
          discountCents: line.discountCents,
          lineSubtotalCents: line.lineSubtotalCents,
        } });
        if (line.type !== OrderLineType.MATERIAL) {
          const job = await tx.productionJob.create({
            data: { orderId: created.id, orderLineId: createdLine.id },
          });
          await tx.productionStageHistory.create({
            data: { jobId: job.id, stage: 'ORDER_RECEIVED', progress: 0, userId: actor.id },
          });
        } else if (line.itemId) {
          materialQuantities.set(line.itemId, (materialQuantities.get(line.itemId) ?? 0) + line.quantity);
        }
      }
      for (const [itemId, quantity] of materialQuantities) {
        const item = await tx.inventoryItem.findUnique({ where: { id: itemId } });
        if (!item?.controlsStock) continue;
        const updated = await tx.inventoryItem.updateMany({
          where: { id: itemId, stock: { gte: new Prisma.Decimal(quantity) } },
          data: { stock: { decrement: new Prisma.Decimal(quantity) } },
        });
        if (updated.count !== 1) throw new ConflictException(`Stock insuficiente de ${item.name} para este pedido.`);
        await tx.inventoryMovement.create({ data: {
          itemId, quantity: new Prisma.Decimal(quantity), action: 'ORDER_MATERIAL_SOLD',
          note: `Venta confirmada en ${code}`, userId: actor.id,
        } });
      }
      await tx.auditLog.create({ data: { userId: actor.id, action: 'ORDER_CREATED', entity: 'Order', entityId: created.id, metadata: { code, totalCents, lines: normalizedLines.length } } });
      return tx.order.findUniqueOrThrow({
        where: { id: created.id },
        include: { customer: true, lines: { include: { product: true, item: true, job: true } } },
      });
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    return order;
  }

  async updateOrderStatus(actor: AuthUser, id: string, statusValue: unknown) {
    const status = String(statusValue) as OrderStatus;
    if (!Object.values(OrderStatus).includes(status)) throw new BadRequestException('Estado de pedido inválido.');
    const result = await this.prisma.$transaction(async (tx) => {
      const order = await tx.order.findUnique({ where: { id }, include: { jobs: true } });
      if (!order) throw new NotFoundException('Pedido no encontrado.');
      if (['CANCELLED', 'DELIVERED'].includes(order.status)) throw new ConflictException('El pedido ya está cerrado.');
      if (status === OrderStatus.IN_PRODUCTION) throw new ConflictException('El estado de producción se actualiza al reservar materiales.');
      if (status === OrderStatus.READY) {
        const remaining = await tx.productionJob.count({ where: { orderId: id, status: { not: 'COMPLETED' } } });
        if (remaining > 0) throw new ConflictException('La producción debe completar sus etapas antes de marcar el pedido listo.');
      }
      if (status === OrderStatus.DELIVERED && order.status !== OrderStatus.READY) throw new ConflictException('El pedido debe estar listo antes de marcarlo entregado.');
      if (status === OrderStatus.CONFIRMED && order.status !== OrderStatus.DRAFT) throw new ConflictException('No se puede regresar el pedido a confirmado.');
      if (status === OrderStatus.CANCELLED && order.jobs.length) {
        const startedJobs = await tx.productionJob.count({ where: { orderId: id, progress: { gt: 0 } } });
        if (startedJobs) throw new ConflictException('Libera los materiales reservados antes de cancelar el pedido.');
      }
      if (status === OrderStatus.CANCELLED) {
        const soldLines = await tx.orderLine.findMany({
          where: { orderId: id, type: OrderLineType.MATERIAL, itemId: { not: null } },
          include: { item: true },
        });
        const quantities = new Map<string, { quantity: number; name: string }>();
        for (const line of soldLines) {
          if (!line.item?.controlsStock || !line.itemId) continue;
          const current = quantities.get(line.itemId) ?? { quantity: 0, name: line.item.name };
          current.quantity += line.quantity;
          quantities.set(line.itemId, current);
        }
        for (const [itemId, row] of quantities) {
          await tx.inventoryItem.update({ where: { id: itemId }, data: { stock: { increment: new Prisma.Decimal(row.quantity) } } });
          await tx.inventoryMovement.create({ data: {
            itemId, quantity: new Prisma.Decimal(row.quantity), action: 'ORDER_MATERIAL_RETURNED',
            note: `Reversión de pedido ${order.code}`, userId: actor.id,
          } });
        }
      }
      const updated = await tx.order.update({ where: { id }, data: { status } });
      return { updated, previousStatus: order.status };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    await this.audit(actor.id, 'ORDER_STATUS_CHANGED', 'Order', id, { from: result.previousStatus, to: status });
    return result.updated;
  }

  async addPayment(actor: AuthUser, id: string, input: JsonRecord) {
    const amountCents = moneyCents(input.amount, 'Monto pagado');
    if (amountCents < 1) throw new BadRequestException('El monto debe ser mayor que cero.');
    const method = String(input.method ?? '').trim();
    if (method.length < 2 || method.length > 40) throw new BadRequestException('Indica un método de pago.');
    return this.prisma.$transaction(async (tx) => {
      const order = await tx.order.findUnique({ where: { id } });
      if (!order) throw new NotFoundException('Pedido no encontrado.');
      if (order.status === OrderStatus.CANCELLED) throw new ConflictException('No se pueden registrar pagos en un pedido cancelado.');
      if (order.paidCents + amountCents > order.totalCents) throw new ConflictException('El pago supera el saldo pendiente.');
      await tx.payment.create({ data: { orderId: id, amountCents, method, observation: optionalText(input.observation, 500), paidAt: optionalDate(input.paidAt, 'La fecha de pago') ?? new Date() } });
      const paidCents = order.paidCents + amountCents;
      const paymentStatus = paidCents === order.totalCents ? PaymentStatus.PAID : PaymentStatus.PARTIAL;
      await tx.order.update({ where: { id }, data: { paidCents, paymentStatus } });
      await tx.auditLog.create({ data: { userId: actor.id, action: 'PAYMENT_RECORDED', entity: 'Order', entityId: id, metadata: { amountCents, method } } });
      return { paidCents, totalCents: order.totalCents, paymentStatus };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  }
}
