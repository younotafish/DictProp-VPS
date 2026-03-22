FROM node:22-alpine

WORKDIR /app

# Install server dependencies
COPY server/package*.json ./server/
RUN cd server && npm ci --production

# Copy server source (pre-built)
COPY server/dist/ ./server/dist/

# Copy built frontend
COPY dist/ ./dist/

# Data directory for SQLite
RUN mkdir -p /app/data

EXPOSE 3000

ENV PORT=3000
ENV DATA_DIR=/app/data

CMD ["node", "server/dist/index.js"]
