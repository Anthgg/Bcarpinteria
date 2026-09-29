# Carpinteria Ordenada 360 - Backend (Foundation)

Node.js + TypeScript + NestJS + Prisma + PostgreSQL (Docker).

## Comandos

```bash
npm install
npm run typecheck      # TypeScript check
npm run build          # build a dist/
npm test               # tests base
npx prisma validate    # valida schema.prisma
```

## Base de datos

El stack completo (frontend + backend + postgres) se levanta desde el
repositorio del frontend:

```bash
cd C:\Users\anthg\Carpinteria
docker compose up --build
```

No exponer PostgreSQL al host: solo vive en la red Docker con volumen
persistente `carpinteria_pgdata`.

## Excel externo

`bd/inventario g.xlsx` se monta en el contenedor como `/app/bd` en **solo
lectura**. En esta fase el backend unicamente comprueba que el archivo existe
(`GET /api/health -> excel.exists`). No se importa ni se modifica.

## Health

`GET /api/health` devuelve `200` con `API OK`, `PostgreSQL conectado` y
`entorno LOCAL`. Devuelve `503` mientras PostgreSQL no responda.
