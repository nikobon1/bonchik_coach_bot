FROM node:20-alpine AS deps
WORKDIR /app

COPY package*.json ./
COPY api/package.json api/package.json
COPY workers/package.json workers/package.json
COPY shared/package.json shared/package.json

RUN npm ci

FROM deps AS builder
WORKDIR /app
COPY . .
RUN npm run build

FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production

COPY --from=deps /app/node_modules ./node_modules
COPY --from=builder /app/api/dist ./api/dist
COPY --from=builder /app/workers/dist ./workers/dist
COPY --from=builder /app/shared/dist ./shared/dist
COPY package*.json ./
COPY api/package.json api/package.json
COPY workers/package.json workers/package.json
COPY shared/package.json shared/package.json
COPY scripts/start.mjs scripts/start.mjs
COPY migrations migrations

CMD ["node", "scripts/start.mjs"]
