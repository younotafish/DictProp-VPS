FROM node:22-alpine AS builder

WORKDIR /app

# Install frontend dependencies and build
COPY package.json package-lock.json ./
RUN npm pkg delete devDependencies.canvas devDependencies.@playwright/test && npm ci
COPY index.html index.tsx tsconfig.json postcss.config.js ./
COPY App.tsx types.ts ./
COPY src/ ./src/
COPY public/ ./public/
COPY views/ ./views/
COPY services/ ./services/
COPY components/ ./components/
COPY hooks/ ./hooks/
COPY vite.config.ts ./
RUN npm run build

# Install server dependencies and build
COPY server/package.json server/package-lock.json ./server/
RUN cd server && npm ci
COPY server/tsconfig.json ./server/
COPY server/src/ ./server/src/
RUN cd server && npm run build

# --- Production image ---
FROM node:22-alpine

WORKDIR /app

# Server production deps only
COPY server/package.json server/package-lock.json ./server/
RUN cd server && npm ci --production

# Copy built artifacts from builder
COPY --from=builder /app/server/dist/ ./server/dist/
COPY --from=builder /app/dist/ ./dist/

RUN mkdir -p /app/data

EXPOSE 3000

ENV PORT=3000
ENV DATA_DIR=/app/data

CMD ["node", "server/dist/index.js"]
