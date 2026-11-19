# ==============================================================================
# ClusterLab Production Multi-Stage Containerfile
# Node 22 Alpine - Minimal, secure, non-root runtime
# ==============================================================================

# Stage 1: Build client and server bundles
FROM node:22-alpine AS builder
WORKDIR /app

# Install dependencies (cached layer)
COPY package.json package-lock.json ./
RUN npm ci

# Copy source and configurations
COPY tsconfig.json vite.config.ts server.ts index.html ./
COPY src/ ./src/
COPY public/ ./public/

# Run type checks and build production assets
RUN npm run lint
RUN npm run build

# Stage 2: Minimal runtime image
FROM node:22-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3000

# Install production dependencies only
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# Copy pre-compiled bundles from builder
COPY --from=builder /app/dist ./dist

# Run as non-root user for container security
USER node

EXPOSE 3000

# Start compiled Express server
CMD ["node", "dist/server.js"]
