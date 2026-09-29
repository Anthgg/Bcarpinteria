import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL must point to a disposable test database.');

const databaseName = decodeURIComponent(new URL(databaseUrl).pathname.replace(/^\/+/, ''));
if (!databaseName.toLowerCase().includes('test') || process.env.APP_ENV === 'production') {
  throw new Error('Refusing to run the reservation race outside a non-production database whose name contains "test".');
}

const prisma = new PrismaClient();
const pieceId = randomUUID();
const jobIds = [randomUUID(), randomUUID()];
const reservationIds = [randomUUID(), randomUUID()];
const conflictCodes = new Set(['P2002', '23505']);

try {
  const indexes = await prisma.$queryRaw`
    SELECT indexname FROM pg_indexes
    WHERE schemaname = 'public' AND indexname = 'PieceReservation_one_active_per_piece_idx'
  `;
  if (indexes.length !== 1) throw new Error('The active-piece reservation unique index is missing.');

  let readyCount = 0;
  let releaseBarrier;
  const barrier = new Promise((resolve) => { releaseBarrier = resolve; });
  const reserve = (jobId, reservationId) => prisma.$transaction(async (tx) => {
    // This isolated test has no fixture rows; skip only FK triggers so the real partial unique index is exercised.
    await tx.$executeRaw`SET LOCAL session_replication_role = 'replica'`;
    readyCount += 1;
    if (readyCount === 2) releaseBarrier();
    await barrier;
    await tx.$executeRaw`
      INSERT INTO "PieceReservation" ("id", "jobId", "pieceId", "status", "reservedAt")
      VALUES (${reservationId}, ${jobId}, ${pieceId}, 'RESERVED', NOW())
    `;
    await tx.$queryRaw`SELECT pg_sleep(0.1) IS NULL AS waited`;
  }, { maxWait: 10_000, timeout: 10_000 });

  const outcomes = await Promise.allSettled(jobIds.map((jobId, index) => reserve(jobId, reservationIds[index])));
  const winners = outcomes.filter((outcome) => outcome.status === 'fulfilled');
  const losers = outcomes.filter((outcome) => outcome.status === 'rejected');
  const loserCode = losers[0]?.reason?.meta?.code ?? losers[0]?.reason?.code;
  const loserMessage = losers[0]?.reason?.message;
  if (winners.length !== 1 || losers.length !== 1 || !conflictCodes.has(loserCode)) {
    throw new Error(`Expected one reservation and one unique-index conflict; received ${winners.length} winners and ${losers.length} losers (${loserCode ?? 'unknown error'}: ${loserMessage ?? 'no message'}).`);
  }

  const rows = await prisma.$queryRaw`
    SELECT count(*)::int AS count FROM "PieceReservation"
    WHERE "pieceId" = ${pieceId} AND "status" = 'RESERVED'
  `;
  if (rows[0]?.count !== 1) throw new Error('The concurrent reservation left an unexpected number of active rows.');
  process.stdout.write('Reservation race passed: one transaction won, the competing insert hit the unique index.\n');
} finally {
  await prisma.$executeRaw`DELETE FROM "PieceReservation" WHERE "id" IN (${reservationIds[0]}, ${reservationIds[1]})`.catch(() => undefined);
  await prisma.$disconnect();
}
