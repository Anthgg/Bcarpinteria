import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';

const origin = (process.env.CARPINTERIA_URL ?? 'http://127.0.0.1:8080').replace(/\/$/, '');
const api = `${origin}/api`;
const adminEmail = process.env.V1_ADMIN_EMAIL ?? 'admin@local.test';
const adminPassword = process.env.V1_ADMIN_PASSWORD;
if (!adminPassword) throw new Error('Define V1_ADMIN_PASSWORD para ejecutar la prueba V1.');

const stamp = Date.now();
const report = {};
let stage = 'health y sesión';

async function parse(response) {
  const bytes = new Uint8Array(await response.arrayBuffer());
  const contentType = response.headers.get('content-type') ?? '';
  let data = null;
  if (contentType.includes('application/json')) {
    const text = new TextDecoder().decode(bytes);
    try { data = JSON.parse(text); } catch { data = text; }
  }
  return { status: response.status, headers: response.headers, contentType, bytes, data };
}

async function call(method, path, cookie, body, expectedStatus) {
  const headers = {};
  if (cookie) headers.cookie = cookie;
  let payload;
  if (body instanceof FormData) payload = body;
  else if (body !== undefined) {
    headers['content-type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  const result = await parse(await fetch(`${api}${path}`, { method, headers, body: payload }));
  if (expectedStatus !== undefined) {
    assert.equal(result.status, expectedStatus, `${method} ${path}: esperado ${expectedStatus}, recibido ${result.status}: ${JSON.stringify(result.data)}`);
  } else {
    assert.ok(result.status >= 200 && result.status < 300, `${method} ${path}: ${result.status}: ${JSON.stringify(result.data)}`);
  }
  return result;
}

async function login(email, password) {
  const result = await parse(await fetch(`${api}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }),
  }));
  assert.ok(result.status >= 200 && result.status < 300, `Login ${email}: ${JSON.stringify(result.data)}`);
  const cookies = result.headers.getSetCookie().map((value) => value.split(';')[0]);
  assert.ok(cookies.length >= 2, 'El login debe establecer las cookies access y refresh.');
  return { cookie: cookies.join('; '), user: result.data.user };
}

try {
  const health = (await call('GET', '/health')).data;
  assert.equal(health.database.connected, true);
  assert.equal(health.excel.readOnly, true);
  const bootstrapAdmin = await login(adminEmail, adminPassword);
  assert.equal(bootstrapAdmin.user.role, 'ADMIN');
  const testerPassword = randomBytes(24).toString('base64url');
  const testerEmail = `tester.${stamp}@local.test`;
  await call('POST', '/users', bootstrapAdmin.cookie, {
    email: testerEmail, name: `Tester V1 ${stamp}`, password: testerPassword, role: 'TESTER',
  }, 201);
  const admin = await login(testerEmail, testerPassword);
  assert.equal(admin.user.role, 'TESTER');
  assert.equal((await call('GET', '/auth/me', admin.cookie)).data.role, 'TESTER');
  report.auth = 'ADMIN de aprovisionamiento + Tester en flujo V1, access y refresh';

  stage = 'previsualización e importación Excel';
  const preview = (await call('GET', '/inventory/import/preview', admin.cookie)).data;
  assert.ok(preview.validRows > 0);
  assert.equal(preview.invalidRows, 0);
  const firstImport = (await call('POST', '/inventory/import', admin.cookie)).data;
  const repeatedImport = (await call('POST', '/inventory/import', admin.cookie)).data;
  assert.equal(firstImport.imported + firstImport.skipped, preview.validRows);
  assert.equal(repeatedImport.imported, 0);
  assert.equal(repeatedImport.skipped, preview.validRows);
  report.excel = { valid: preview.validRows, invalid: preview.invalidRows, firstImport, repeat: repeatedImport };

  stage = 'cliente y artículos';
  const customer = (await call('POST', '/customers', admin.cookie, {
    name: `V1 Demo Cliente ${stamp}`, documentType: 'OTRO', documentNumber: `V1-${stamp}`,
    email: `v1.${stamp}@local.test`, phone: '999000111', address: 'Taller local',
  }, 201)).data;
  const consumable = (await call('POST', '/inventory/items', admin.cookie, {
    name: `Consumible V1 ${stamp}`, type: 'CONSUMIBLE', unit: 'UNIDAD', stock: 10,
    controlsStock: true, productionConsumable: true,
  }, 201)).data;
  const wood = (await call('POST', '/inventory/items', admin.cookie, {
    name: `Madera V1 ${stamp}`, type: 'MATERIAL', unit: 'TABLON', stock: 0, controlsStock: true,
    requiresDimensions: true, lengthMm: 2400, widthMm: 1200, thicknessMm: 18,
  }, 201)).data;
  const sellable = (await call('POST', '/inventory/items', admin.cookie, {
    name: `Tablero comercial V1 ${stamp}`, type: 'MATERIAL', unit: 'UNIDAD', stock: 5,
    unitPrice: 20, sellable: true, controlsStock: true,
  }, 201)).data;
  const board = (await call('POST', '/inventory/pieces', admin.cookie, {
    materialId: wood.id, lengthMm: 2400, widthMm: 1200, thicknessMm: 18, fromExistingStock: false,
  }, 201)).data;

  stage = 'pedido personalizado, venta y pago';
  const order = (await call('POST', '/orders', admin.cookie, {
    customerId: customer.id,
    notes: 'Pedido de demostración V1.',
    lines: [
      { type: 'CUSTOM', name: `Mesa demostración V1 ${stamp}`, description: 'Mesa a medida.', lengthMm: 1800, widthMm: 900, heightMm: 750, quantity: 1, unitPrice: 1000, discount: 100 },
      { type: 'MATERIAL', itemId: sellable.id, quantity: 1, unitPrice: 20, discount: 0 },
    ],
  }, 201)).data;
  assert.equal(order.totalCents, 108560);
  assert.equal(order.taxCents, 16560);
  assert.equal(order.discountCents, 10000);
  const inventoryPath = '/inventory';
  let inventory = (await call('GET', inventoryPath, admin.cookie)).data;
  assert.equal(Number(inventory.find((item) => item.id === sellable.id).stock), 4);
  const payment = (await call('POST', `/orders/${order.id}/payments`, admin.cookie, {
    amount: 500, method: 'EFECTIVO', observation: 'Abono de presentación',
  }, 201)).data;
  assert.equal(payment.paymentStatus, 'PARTIAL');
  assert.equal(payment.paidCents, 50000);
  const detail = (await call('GET', `/orders/${order.id}`, admin.cookie)).data;
  assert.ok(detail.trackingToken);
  const customLine = detail.lines.find((line) => line.type === 'CUSTOM' && line.job?.id);
  assert.ok(customLine, 'La línea personalizada debe crear una tarea de producción.');
  const jobId = customLine.job.id;
  report.order = { code: detail.code, totalCents: detail.totalCents, taxCents: detail.taxCents, paymentStatus: detail.paymentStatus };

  stage = 'materiales, sugerencia de corte y reserva';
  await call('PUT', `/production/${jobId}/materials`, admin.cookie, {
    components: [{ materialId: consumable.id, label: 'Consumible de montaje', quantity: 1 }],
    pieces: [{ materialId: wood.id, label: 'Cubierta', lengthMm: 1200, widthMm: 600, thicknessMm: 18, quantity: 1 }],
  });
  const piecesPath = `/inventory/pieces?itemId=${encodeURIComponent(wood.id)}`;
  let pieces = (await call('GET', piecesPath, admin.cookie)).data;
  inventory = (await call('GET', inventoryPath, admin.cookie)).data;
  assert.equal(Number(inventory.find((item) => item.id === consumable.id).stock), 10);
  assert.equal(pieces.find((piece) => piece.id === board.id).state, 'AVAILABLE');
  const plan = (await call('POST', `/production/${jobId}/cutting/simulate`, admin.cookie, { strategy: 'OFFCUTS_FIRST', kerfMm: 3 }, 201)).data;
  assert.equal(plan.summary.boardsUsed, 1);
  assert.equal(plan.unplaced.length, 0);
  pieces = (await call('GET', piecesPath, admin.cookie)).data;
  inventory = (await call('GET', inventoryPath, admin.cookie)).data;
  assert.equal(Number(inventory.find((item) => item.id === consumable.id).stock), 10);
  assert.equal(pieces.find((piece) => piece.id === board.id).state, 'AVAILABLE');
  const reservation = (await call('POST', `/production/${jobId}/cutting/${plan.id}/confirm`, admin.cookie, undefined, 201)).data;
  pieces = (await call('GET', piecesPath, admin.cookie)).data;
  inventory = (await call('GET', inventoryPath, admin.cookie)).data;
  assert.equal(reservation.reservedPieces, 1);
  assert.equal(Number(inventory.find((item) => item.id === consumable.id).stock), 9);
  assert.equal(pieces.find((piece) => piece.id === board.id).state, 'RESERVED');
  report.cutting = { boardsUsed: plan.summary.boardsUsed, kerfMm: plan.kerfMm, reservedPieces: reservation.reservedPieces };

  stage = 'corte real y decisión del retazo';
  const cut = (await call('POST', `/production/${jobId}/cutting/complete`, admin.cookie, {}, 201)).data;
  pieces = (await call('GET', piecesPath, admin.cookie)).data;
  assert.equal(cut.job.stage, 'CUTTING');
  assert.ok(cut.offcutsCreated > 0);
  assert.equal(pieces.find((piece) => piece.id === board.id).state, 'CONSUMED');
  const pendingOffcut = pieces.find((piece) => piece.kind === 'OFFCUT' && piece.state === 'PENDING_DISPOSITION');
  assert.ok(pendingOffcut);
  const keptOffcut = (await call('PATCH', `/inventory/pieces/${pendingOffcut.id}/state`, admin.cookie, {
    state: 'AVAILABLE', note: 'Conservar para otro pedido',
  })).data;
  assert.equal(keptOffcut.state, 'AVAILABLE');
  report.cut = { sourceState: 'CONSUMED', offcuts: cut.offcutsCreated, kept: keptOffcut.code };

  stage = 'notas, incidencia y foto';
  const privateNote = `NOTA_INTERNA_PRIVADA_${stamp}`;
  await call('POST', `/production/${jobId}/notes`, admin.cookie, { visibility: 'INTERNAL', content: privateNote }, 201);
  await call('POST', `/production/${jobId}/notes`, admin.cookie, { visibility: 'PUBLIC', content: 'Avance de demostración compartido.' }, 201);
  const beforeIncident = (await call('GET', `/production/${jobId}`, admin.cookie)).data;
  await call('POST', `/production/${jobId}/incidents`, admin.cookie, {
    title: 'Ajuste de presentación', description: 'Incidencia independiente del avance.',
  }, 201);
  const afterIncident = (await call('GET', `/production/${jobId}`, admin.cookie)).data;
  assert.equal(afterIncident.progress, beforeIncident.progress, 'La incidencia no debe modificar el porcentaje.');
  const form = new FormData();
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/3ioAAAAASUVORK5CYII=', 'base64');
  form.set('caption', 'Foto de avance V1');
  form.set('public', 'true');
  form.set('photo', new Blob([png], { type: 'image/png' }), 'demo.png');
  const photo = (await call('POST', `/production/${jobId}/photos`, admin.cookie, form, 201)).data;
  assert.equal(photo.public, true);
  report.photo = { id: photo.id, public: photo.public };

  stage = 'avance secuencial hasta listo';
  for (const next of ['ASSEMBLY', 'SANDING', 'FINISHING', 'QUALITY_CONTROL', 'READY']) {
    await call('POST', `/production/${jobId}/stage`, admin.cookie, { stage: next, note: 'Validación V1' }, 201);
  }
  const readyJob = (await call('GET', `/production/${jobId}`, admin.cookie)).data;
  const readyOrder = (await call('GET', `/orders/${order.id}`, admin.cookie)).data;
  assert.equal(readyJob.progress, 100);
  assert.equal(readyJob.status, 'COMPLETED');
  assert.equal(readyOrder.status, 'READY');
  report.production = { stage: readyJob.stage, progress: readyJob.progress, history: readyJob.stageHistory.length, incidents: readyJob.incidents.length };

  stage = 'PDF, seguimiento y foto pública';
  const pdf = await call('GET', `/orders/${order.id}/pdf`, admin.cookie);
  assert.ok(pdf.contentType.includes('application/pdf'));
  assert.equal(new TextDecoder().decode(pdf.bytes.slice(0, 4)), '%PDF');
  assert.ok(pdf.bytes.length > 1000);
  const tracking = (await call('GET', `/public/track/${readyOrder.trackingToken}`)).data;
  const publicJson = JSON.stringify(tracking);
  assert.equal(tracking.status, 'READY');
  assert.equal(tracking.progress, 100);
  assert.ok(tracking.notes.some((note) => note.content === 'Avance de demostración compartido.'));
  assert.ok(!publicJson.includes(privateNote) && !publicJson.includes('totalCents') && !publicJson.includes('paidCents'));
  assert.ok(tracking.photos.some((entry) => entry.id === photo.id));
  const publicPhoto = await call('GET', `/public/track/${readyOrder.trackingToken}/photos/${photo.id}`);
  assert.ok(publicPhoto.contentType.includes('image/png') && publicPhoto.bytes.length > 30);
  const push = (await call('GET', `/public/track/${readyOrder.trackingToken}/notifications`)).data;
  assert.equal(push.enabled, false);
  report.documents = { pdfHeader: '%PDF', bytes: pdf.bytes.length };
  report.tracking = { status: tracking.status, progress: tracking.progress, notes: tracking.notes.length, photos: tracking.photos.length, pushEnabled: push.enabled };

  stage = 'dashboard, auditoría y RBAC operario';
  const dashboard = (await call('GET', '/dashboard', admin.cookie)).data;
  const audit = (await call('GET', '/dashboard/audit', admin.cookie)).data;
  assert.ok(dashboard && audit);
  const operatorPassword = randomBytes(24).toString('base64url');
  const operatorEmail = `operator.${stamp}@local.test`;
  const operator = (await call('POST', '/users', admin.cookie, {
    email: operatorEmail, name: `Operario V1 ${stamp}`, password: operatorPassword, role: 'OPERARIO',
  }, 201)).data;
  assert.equal(operator.role, 'OPERARIO');
  const operatorSession = await login(operatorEmail, operatorPassword);
  assert.equal(operatorSession.user.role, 'OPERARIO');
  await call('GET', '/production', operatorSession.cookie);
  await call('GET', '/inventory', operatorSession.cookie);
  await call('GET', '/customers', operatorSession.cookie, undefined, 403);
  await call('GET', '/users', operatorSession.cookie, undefined, 403);
  report.rbac = 'Operario: inventario/producción permitidos; clientes/usuarios denegados';
  report.auditRecords = Array.isArray(audit) ? audit.length : undefined;
  console.log(JSON.stringify({ ok: true, stage: 'completado', report, orderId: order.id, jobId }, null, 2));
} catch (error) {
  console.error(JSON.stringify({ ok: false, stage, error: String(error?.stack ?? error), report }, null, 2));
  process.exitCode = 1;
}
