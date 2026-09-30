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

FROM base AS dev
COPY --from=deps /app/node_modules ./node_modules
COPY package.json package-lock.json nest-cli.json tsconfig.json tsconfig.build.json ./
COPY prisma ./prisma
COPY src ./src
RUN npx prisma generate
EXPOSE 3000
CMD ["npm", "run", "start:dev"]

FROM base AS production
ENV NODE_ENV=production
RUN mkdir -p /app/uploads && chown node:node /app/uploads
COPY --chown=node:node --from=build /app/node_modules ./node_modules
COPY --chown=node:node --from=build /app/dist ./dist
COPY --chown=node:node --from=build /app/prisma ./prisma
COPY --chown=node:node --from=build /app/assets ./assets
COPY --chown=node:node package.json package-lock.json ./
USER node
EXPOSE 3000
CMD ["npm", "run", "start:prod"]
