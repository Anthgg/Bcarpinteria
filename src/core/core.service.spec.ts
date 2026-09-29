import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import ExcelJS from 'exceljs';
import type { PrismaService } from '../prisma.service';
import { CoreService } from './core.service';

describe('CoreService inventory workbook import', () => {
  let directory: string;
  let previousPath: string | undefined;
  let service: CoreService;
  const findMany = jest.fn();

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'carpinteria-inventory-'));
    previousPath = process.env.BD_PATH;
    findMany.mockReset().mockResolvedValue([]);
    service = new CoreService({ inventoryItem: { findMany } } as unknown as PrismaService);
  });

  afterEach(async () => {
    if (previousPath === undefined) delete process.env.BD_PATH;
    else process.env.BD_PATH = previousPath;
    if (resolve(directory).startsWith(resolve(tmpdir()))) await rm(directory, { recursive: true, force: true });
  });

  it('previews the supplied workbook without changing it', async () => {
    const workbookPath = resolve(__dirname, '../../bd/inventario g.xlsx');
    process.env.BD_PATH = workbookPath;

    const report = await service.previewImport();

    expect(report).toMatchObject({ source: 'inventario g.xlsx', sheet: expect.any(String), validRows: 14, invalidRows: 0 });
    expect(report.rows).toHaveLength(14);
    expect(findMany).toHaveBeenCalledTimes(1);
  });

  it('reports duplicate names and blank stock before import', async () => {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('Inventario');
    sheet.addRow(['ID', 'MATERIAL', 'UNIDAD', 'STOCK', 'PRECIO UNITARIO']);
    sheet.addRow(['A-1', 'Pino seco', 'UND', 2, 15.5]);
    sheet.addRow(['A-2', 'PINO SECO', 'UND', 1, 14]);
    sheet.addRow(['A-3', 'Barniz mate', 'L', '', 18]);
    const workbookPath = join(directory, 'validation.xlsx');
    await workbook.xlsx.writeFile(workbookPath);
    process.env.BD_PATH = workbookPath;

    const report = await service.previewImport();

    expect(report).toMatchObject({ validRows: 1, invalidRows: 2 });
    expect(report.rows[1].error).toMatch(/duplicado/i);
    expect(report.rows[2].error).toMatch(/stock/i);
  });
});
