# Carpintería Ordenada 360° — Backend V1

API local en Node.js, TypeScript, NestJS 11 y Prisma sobre PostgreSQL. El frontend y PostgreSQL siguen en el Compose aprobado; la API se sirve bajo `/api` y el único puerto local publicado es `127.0.0.1:8080`.

## Módulos

- **Auth y RBAC:** contraseñas con bcrypt, cookies HttpOnly SameSite Strict, access token breve, refresh token rotativo asociado a sesión, cierre/revocación de sesiones y controles `TESTER`, `ADMIN` y `OPERARIO`.
- **Inventario:** lectura y previsualización del Excel de solo lectura, importación validada e idempotente, edición de artículos, ajustes con historial, piezas físicas y decisión sobre retazos.
- **Clientes, productos y pedidos:** CRUD de clientes/productos, líneas de catálogo/personalizadas/material, dimensiones en mm, precios en centavos, IGV configurable, pagos y cambios válidos de estado.
- **Producción:** componentes y piezas por producto, simulación de corte 2D sin efectos laterales, reservas transaccionales, consumo y generación de retazos pendientes de decisión, etapas, notas, incidencias y fotos.
- **Seguimiento y documentos:** vista pública limitada por token aleatorio, PDF comercial con QR y Web Push opcional mediante VAPID.
- **Dashboard y auditoría:** conteos y movimientos consultados desde PostgreSQL; operaciones sensibles escriben su rastro de auditoría.

## API principal

| Área | Rutas |
| --- | --- |
| Sesión | `POST /api/auth/login`, `POST /api/auth/refresh`, `POST /api/auth/logout`, `GET /api/auth/me` |
| Usuarios | `GET/POST /api/users`, `PUT /api/users/:id` |
| Inventario | `GET /api/inventory`, `/pieces`, `/movements`; `GET /api/inventory/import/preview`; `POST /api/inventory/import`; CRUD y stock bajo `/api/inventory/items`; piezas bajo `/api/inventory/pieces` |
| Clientes/productos | `GET/POST/PUT/DELETE /api/customers`; `GET/POST/PUT/DELETE /api/products` |
| Pedidos | `GET/POST /api/orders`, `GET /api/orders/:id`, `PUT /api/orders/:id/status`, `POST /api/orders/:id/payments`, `GET /api/orders/:id/pdf` |
| Producción | `GET /api/production`, `GET /api/production/:id` y rutas de materiales, simulación, reserva, corte, etapas, pausa, notas, incidencias y fotos |
| Cliente | `GET /api/public/track/:token` y rutas de suscripción/fotos públicas |
| Resumen | `GET /api/dashboard`, `GET /api/dashboard/audit`, `GET /api/health` |

Las operaciones de reserva, consumo, importación, pedido y pago usan transacciones. Una venta directa de material reduce stock cuando el artículo controla stock; cancelar un pedido permitido revierte ese movimiento una sola vez y deja su historial.

## Arranque local

Desde `C:\Users\anthg\Carpinteria`:

```powershell
docker compose up --build
```

Abre <http://127.0.0.1:8080>. El Excel se monta en el backend como solo lectura. PostgreSQL solo es accesible dentro de la red Docker; `carpinteria_pgdata` y `carpinteria_uploads` persisten datos y fotos.

Al iniciar, el backend aplica las migraciones Prisma pendientes. Para crear el administrador local, define una dirección y una contraseña propia de al menos 12 caracteres sin guardarla en el repositorio, luego ejecuta desde la carpeta frontend:

```powershell
$env:SEED_ADMIN_EMAIL = 'admin@local.test'
$env:SEED_ADMIN_PASSWORD = '<contraseña propia de 12 o más caracteres>'
docker compose exec -e SEED_ADMIN_EMAIL -e SEED_ADMIN_PASSWORD backend npm run seed
Remove-Item Env:SEED_ADMIN_EMAIL, Env:SEED_ADMIN_PASSWORD
```

Opcionalmente configura cada par `SEED_TESTER_EMAIL`/`SEED_TESTER_PASSWORD` y `SEED_OPERATOR_EMAIL`/`SEED_OPERATOR_PASSWORD`. Repetir el seed actualiza la cuenta que tenga ese correo y carga la configuración/productos iniciales; no restablece los demás datos.

## Variables

Compose lee `Carpinteria/.env` (ver `.env.example`). El backend también ofrece `Bcarpinteria/.env.example` para ejecución local directa.

- `DATABASE_URL`, `POSTGRES_*`: PostgreSQL local. En Compose la URL apunta al servicio `postgres`.
- `JWT_SECRET`: clave estable de al menos 32 bytes para conservar sesiones válidas tras reiniciar el proceso. En desarrollo vacío crea una clave efímera y cierra las sesiones firmadas al reiniciar.
- `CORS_ORIGINS`: lista separada por coma; por defecto permite los puertos locales 8080 y 5173.
- `BD_PATH`: libro fuente, de solo lectura.
- `UPLOAD_DIR`: almacenamiento de fotos local persistente.
- `PUBLIC_BASE_URL`: origen que se inserta en avisos de Web Push.
- `VAPID_SUBJECT`, `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`: opcionales. Sin ellas, el resto del seguimiento funciona y no se solicitan permisos de notificación.

## Comprobaciones

Desde `Bcarpinteria`:

```powershell
npm run typecheck
npm run build
npm test -- --runInBand
npx prisma validate
npx prisma migrate deploy
```

## Fuera de V1

No se conecta Supabase ni servicios cloud, SUNAT, pasarelas de pago, WhatsApp Business API, CAD o IA. WhatsApp abre un mensaje prellenado que una persona envía manualmente.
