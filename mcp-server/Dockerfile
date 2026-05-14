# Audrey TCP MCP server
# Multi-stage build: compile TypeScript, then run a minimal image.

FROM node:20-alpine AS builder
WORKDIR /app

# Install dependencies first for better cache hits
COPY package.json package-lock.json* ./
RUN npm ci

# Build
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# ---

FROM node:20-alpine AS runtime
WORKDIR /app

# Production-only deps
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev && npm cache clean --force

# Compiled output
COPY --from=builder /app/dist ./dist

# Non-root user (Railway runs as root by default; we don't)
RUN addgroup -S audrey && adduser -S audrey -G audrey
USER audrey

ENV NODE_ENV=production
EXPOSE 8080

CMD ["node", "dist/index.js"]
