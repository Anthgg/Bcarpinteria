const { PrismaClient } = require('@prisma/client');
const { hash } = require('bcryptjs');

const prisma = new PrismaClient();

async function main() {
  const required = ['SEED_ADMIN_EMAIL', 'SEED_ADMIN_PASSWORD'];
  for (const key of required) {
    if (!process.env[key]) throw new Error(`${key} es obligatorio para crear el usuario administrador local.`);
  }
  const definitions = [
    ['SEED_ADMIN', 'ADMIN'],
    ['SEED_TESTER', 'TESTER'],
    ['SEED_OPERATOR', 'OPERARIO'],
  ];
  for (const [prefix, role] of definitions) {
    const email = process.env[`${prefix}_EMAIL`]?.trim().toLowerCase();
    const password = process.env[`${prefix}_PASSWORD`];
    if (!email && !password) continue;
    if (!email || !password) throw new Error(`${prefix}_EMAIL y ${prefix}_PASSWORD deben configurarse juntos.`);
    if (password.length < 12 || password.length > 128) throw new Error(`${prefix}_PASSWORD debe tener entre 12 y 128 caracteres.`);
    const passwordHash = await hash(password, 12);
    await prisma.user.upsert({
      where: { email },
      create: { email, name: process.env[`${prefix}_NAME`] || role, role, passwordHash, active: true },
      update: { name: process.env[`${prefix}_NAME`] || role, role, passwordHash, active: true },
    });
  }

  const settings = [
    ['tax_rate_basis_points', '1800'],
    ['cutting_kerf_mm', '3'],
    ['low_stock_threshold', '5'],
    ['company_name', 'Carpintería Ordenada 360°'],
    ['company_phone', ''],
  ];
  for (const [key, value] of settings) {
    await prisma.appSetting.upsert({ where: { key }, create: { key, value }, update: {} });
  }

  const products = [
    ['MES-001', 'Mesa', 'Producto de catálogo para personalizar por pedido.'],
    ['SIL-001', 'Silla', 'Producto de catálogo para personalizar por pedido.'],
    ['ARM-001', 'Armario', 'Producto de catálogo para personalizar por pedido.'],
    ['REP-001', 'Repisero', 'Producto de catálogo para personalizar por pedido.'],
  ];
  for (const [code, name, description] of products) {
    await prisma.product.upsert({ where: { code }, create: { code, name, description, defaultProduct: true }, update: { name, description, defaultProduct: true, active: true } });
  }
  console.log(`Seed local completado. Usuarios configurados: ${definitions.filter(([prefix]) => process.env[`${prefix}_EMAIL`]).length}.`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
}).finally(async () => prisma.$disconnect());
