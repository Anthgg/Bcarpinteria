require('dotenv/config');

const os = require('node:os');
const path = require('node:path');
const { PrismaClient, AppRole } = require('@prisma/client');
const { hash } = require('bcryptjs');

const prisma = new PrismaClient();
const resetPasswords = process.argv.includes('--reset-password');
const readCredentialsFromStdin = process.argv.includes('--credentials-stdin');
const definitions = [
  { role: AppRole.TESTER, email: 'demo-tester@local.test', name: 'Demostración TESTER' },
  { role: AppRole.ADMIN, email: 'demo-admin@local.test', name: 'Demostración ADMIN' },
  { role: AppRole.OPERARIO, email: 'demo-operario@local.test', name: 'Demostración OPERARIO' },
];

function credentialsPath() {
  const profile = process.env.USERPROFILE || os.homedir();
  return process.env.DEMO_USERS_FILE || path.join(profile, '.codex', 'local-secrets', 'Carpinteria', 'demo-access.txt');
}

function parseCredentials(text) {
  const sections = new Map();
  let current;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    if (/^(TESTER|ADMIN|OPERARIO)$/.test(line)) {
      if (sections.has(line)) throw new Error('Duplicate role section.');
      current = new Map();
      sections.set(line, current);
      continue;
    }
    if (!current) continue;
    const match = /^(email|password)=(.+)$/.exec(line);
    if (!match || current.has(match[1])) throw new Error('Invalid credential file format.');
    current.set(match[1], match[2]);
  }

  for (const definition of definitions) {
    const roleName = definition.role;
    const values = sections.get(roleName);
    if (!values || values.size !== 2 || values.get('email')?.toLowerCase() !== definition.email) {
      throw new Error('Credential file roles or emails are invalid.');
    }
    const password = values.get('password');
    if (!password || password.length < 18 || password.length > 128) {
      throw new Error('Demo passwords must contain 18 to 128 characters.');
    }
    definition.password = password;
  }
  if (sections.size !== definitions.length) throw new Error('Unexpected credential file role.');
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
}

async function main() {
  const source = readCredentialsFromStdin
    ? await readStdin()
    : require('node:fs').readFileSync(credentialsPath(), 'utf8');
  parseCredentials(source);

  let created = 0;
  let repaired = 0;
  let unchanged = 0;
  for (const { role, email, name, password } of definitions) {
    const current = await prisma.user.findUnique({ where: { email } });
    if (!current) {
      await prisma.user.create({
        data: { email, name, role, active: true, passwordHash: await hash(password, 12) },
      });
      created += 1;
      console.log(`${role}: cuenta creada.`);
      continue;
    }

    const data = {};
    if (current.role !== role) data.role = role;
    if (!current.active) data.active = true;
    if (resetPasswords) data.passwordHash = await hash(password, 12);
    if (Object.keys(data).length) {
      await prisma.user.update({ where: { email }, data });
      repaired += 1;
      console.log(`${role}: cuenta existente actualizada sin revelar credenciales.`);
    } else {
      unchanged += 1;
      console.log(`${role}: cuenta existente conservada.`);
    }
  }
  console.log(`Seed demo finalizado: ${created} creadas, ${repaired} corregidas, ${unchanged} sin cambios.${resetPasswords ? ' Contraseñas restablecidas por opción explícita.' : ''}`);
}

main()
  .catch(() => {
    console.error('Seed demo falló. Revise la configuración y el formato del archivo local de credenciales.');
    process.exitCode = 1;
  })
  .finally(async () => prisma.$disconnect());
