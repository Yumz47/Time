# ==============================================================================
# TimePulse Attendance System - Production Dockerfile
# Multi-stage / optimized Alpine Node.js deployment
# ==============================================================================

FROM node:22-alpine AS base

# Install dumb-init or required native tools if needed
RUN apk add --no-cache tzdata

WORKDIR /app

# Set default production environment
ENV TZ=America/Belize
ENV NODE_ENV=production
ENV PORT=3000

# Install production dependencies first (layer caching)
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

# Copy application files
COPY server/ ./server/
COPY bridge/ ./bridge/
COPY public/ ./public/

# Use non-root user provided by node image for security compliance
USER node

# Expose HTTP service port
EXPOSE 3000

# Container health probe
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:3000/ || exit 1

# Start TimePulse server
CMD ["node", "server/server.js"]
