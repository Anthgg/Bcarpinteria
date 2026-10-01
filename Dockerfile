# syntax=docker/dockerfile:1
FROM node:22-alpine AS base
WORKDIR /app
ENV npm_config_update_notifier=false

FROM base AS deps
COPY package.json package-lock.json ./
RUN npm ci

FROM deps AS build
COPY nest-cli.json tsconfig.json tsconfig.build.json ./
COPY prisma ./prisma
COPY src ./src
COPY assets ./assets
RUN npx prisma generate && npm run build

# Dependencias de runtime: sin devDependencies (Prisma CLI incluido); conserva el cliente generado.
FROM build AS prod-deps
RUN npm prune --omit=dev

FROM base AS dev
COPY --from=deps /app/node_modules ./node_modules
COPY package.json package-lock.json nest-cli.json tsconfig.json tsconfig.build.json ./
COPY prisma ./prisma
COPY src ./src
RUN npx prisma generate
EXPOSE 3000
CMD ["npm", "run", "start:dev"]

# Imagen de runtime (compose.prod.yml y Cloud Run). Arranca solo la API: las migraciones son un paso
# previo y explícito (npm run db:supabase:deploy) que usa DIRECT_URL, nunca el pooler del runtime.
FROM base AS production
ENV NODE_ENV=production
RUN mkdir -p /app/uploads /tmp/uploads && chown node:node /app/uploads /tmp/uploads
COPY --chown=node:node --from=prod-deps /app/node_modules ./node_modules
COPY --chown=node:node --from=build /app/dist ./dist
COPY --chown=node:node --from=build /app/prisma ./prisma
COPY --chown=node:node --from=build /app/assets ./assets
COPY --chown=node:node package.json package-lock.json ./
USER node
EXPOSE 3000
CMD ["node", "dist/main.js"]
