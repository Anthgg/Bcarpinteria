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

### Dimensiones y diagnóstico del plano de corte

Las piezas físicas (`MaterialPiece`) y las piezas requeridas (`RequiredPiece`) tienen tres dimensiones en milímetros enteros. La interfaz las llama **Largo × Ancho × Alto**: `lengthMm` = Largo, `widthMm` = Ancho, `thicknessMm` = Alto (en madera, el espesor). No existe una cuarta dimensión.

`POST /api/production/:id/cutting/simulate` solo lee inventario y guarda un `CuttingPlan`. El motor usa únicamente `MaterialPiece` en estado `AVAILABLE` del mismo material y el mismo alto; admite giro de 90° y descuenta el kerf (`cutting_kerf_mm`, 3 mm por defecto) entre piezas. El kerf tiene un único límite, `MAX_KERF_MM` = 0–100 mm enteros, que aplican Configuración, la simulación y el motor.

### Unidades de inventario

La unidad de un artículo proviene de un catálogo controlado (`src/common/units.ts`): `UNIDAD`, `TABLON`, `TABLERO` y `JUEGO`, las unidades realmente presentes en PostgreSQL y en el Excel. `GET /api/inventory/units` lo expone con etiquetas para la interfaz (Unidad, Tablón…). Alta, edición e importación normalizan equivalencias explícitas (por ejemplo, «Unidad», «UND» o «Unid.» → `UNIDAD`; «Tablón» → `TABLON`) y rechazan cualquier otra con 400 «Unidad de inventario no válida.»; en la importación, una unidad desconocida queda como error de fila y nunca se crea. No confundir con la unidad dimensional (mm, cm, m).

`PUT /api/production/:id/materials` recibe la lista completa editada (piezas y consumibles) y la reemplaza en una transacción; solo se admite antes de reservar (etapa `ORDER_RECEIVED`, producción activa). `GET /api/inventory/material-availability` (TESTER, ADMIN y OPERARIO, solo lectura) devuelve en consultas agregadas, por artículo activo: stock suelto, cantidad reservada, piezas físicas por estado, piezas `AVAILABLE`, altos disponibles, pieza mayor y el umbral `low_stock_threshold` que también usa el dashboard. El stock numérico de `InventoryItem` no se usa como tabla. Cada pieza en `unplaced` lleva `reason` y `reasonDetails`, y `diagnostics` resume el embudo de candidatos por material y requerimiento:

| Código | Significado |
| --- | --- |
| `NO_PHYSICAL_STOCK` | El material no tiene piezas físicas registradas (aunque tenga stock suelto). |
| `STOCK_RESERVED` | Hay piezas, ninguna disponible y al menos una reservada. |
| `NO_AVAILABLE_STOCK` | Hay piezas, pero están consumidas, por decidir o descartadas. |
| `THICKNESS_MISMATCH` | Hay piezas disponibles, pero ninguna con el alto requerido. |
| `DIMENSIONS_TOO_LARGE` | La pieza no cabe, ni girada, en ninguna tabla disponible vacía. |
| `KERF_NO_FIT` | Cabría en el espacio restante si el corte de sierra fuese 0 mm. |
| `INSUFFICIENT_REMAINING_SPACE` | Cabe en una tabla vacía, pero el stock se agotó con otras piezas. |

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

## Presentación local V1

**Requisitos:** Windows 10/11 con Docker Desktop iniciado en modo de contenedores Linux y Docker Compose v2. Docker ejecuta la API, la interfaz y PostgreSQL; no hace falta instalar PostgreSQL en Windows. Para desarrollo fuera de Docker, usar Node.js 22 y npm. El libro de inventario debe existir en `Bcarpinteria/bd/inventario g.xlsx`.

Desde `C:\Users\anthg\Carpinteria`, prepara `.env` a partir de `.env.example` si aún no existe y ejecuta:

```powershell
docker compose up --build
```

La entrada de la aplicación es <http://127.0.0.1:8080>; la comprobación de API es <http://127.0.0.1:8080/api/health>. Para detener el stack de presentación, desde la misma carpeta ejecuta `docker compose down`. Ese comando conserva los datos: PostgreSQL vive en el volumen Docker `carpinteria_pgdata` y las fotos en `carpinteria_uploads`. No usar `docker compose down -v` para la base de presentación.

`compose.yml` es el modo local de desarrollo: monta el código fuente, ejecuta Vite y NestJS en modo de desarrollo y usa los volúmenes `carpinteria_pgdata`/`carpinteria_uploads`. `compose.prod.yml` compila la interfaz y la API para producción, sirve la interfaz con Nginx, requiere secretos explícitos y usa volúmenes separados `carpinteria_prod_pgdata`/`carpinteria_prod_uploads`; no es necesario para la exposición V1. PostgreSQL solo se publica dentro de la red Docker. El Excel se monta desde `Bcarpinteria/bd` como solo lectura.

Rutas principales: `/` (aplicación y acceso), `/api` (API), `/api/health` (salud) y `/seguimiento/<token>` (seguimiento público). El menú se adapta a `TESTER`, `ADMIN` y `OPERARIO`; la API también valida permisos. Las notificaciones Web Push son opcionales y solo funcionan al configurar `VAPID_SUBJECT`, `VAPID_PUBLIC_KEY` y `VAPID_PRIVATE_KEY`.

### Acceso de demostración

Las cuentas preparadas para esta presentación son `demo-tester@local.test` (`TESTER`), `demo-admin@local.test` (`ADMIN`) y `demo-operario@local.test` (`OPERARIO`). Sus contraseñas están solo en `%USERPROFILE%\.codex\local-secrets\Carpinteria\demo-access.txt`, fuera de ambos repositorios. No las copies a un README, a `.env` ni a otro archivo versionado.

En una base nueva, el seed crea o actualiza las cuentas indicadas por variables de entorno y carga catálogos/configuración inicial. Para crear los tres roles desde PowerShell, define correos y contraseñas temporales para `SEED_TESTER_EMAIL`/`SEED_TESTER_PASSWORD`, `SEED_ADMIN_EMAIL`/`SEED_ADMIN_PASSWORD`, y `SEED_OPERATOR_EMAIL`/`SEED_OPERATOR_PASSWORD`, todos con contraseñas propias de al menos 12 caracteres; luego, desde `C:\Users\anthg\Carpinteria`, ejecuta:

```powershell
docker compose exec -e SEED_TESTER_EMAIL -e SEED_TESTER_PASSWORD -e SEED_ADMIN_EMAIL -e SEED_ADMIN_PASSWORD -e SEED_OPERATOR_EMAIL -e SEED_OPERATOR_PASSWORD backend npm run seed
Remove-Item Env:SEED_TESTER_EMAIL, Env:SEED_TESTER_PASSWORD, Env:SEED_ADMIN_EMAIL, Env:SEED_ADMIN_PASSWORD, Env:SEED_OPERATOR_EMAIL, Env:SEED_OPERATOR_PASSWORD
```

El seed también actualiza los productos iniciales con códigos `MES-001`, `SIL-001`, `ARM-001`, `REP-001` y carga ajustes faltantes. En la base de presentación poblada, evita volver a ejecutarlo: administra usuarios desde Configuración > Usuarios para no alterar el catálogo que se expondrá. Repetir el seed con el mismo correo cambia su contraseña. Guarda cualquier contraseña solo en un archivo local protegido fuera de los repositorios.
