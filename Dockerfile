FROM node:22-alpine AS builder

WORKDIR /app

# Install frontend dependencies and build.
# Skip onnxruntime-node's GPU-binary download: the browser uses onnxruntime-WEB, never the Node
# build, but its postinstall fetches a large CUDA tarball from GitHub that intermittently 504s and
# breaks `npm ci` (which silently kept the old container running). Skipping it makes builds reliable.
ENV ONNXRUNTIME_NODE_INSTALL_CUDA=skip
COPY package.json package-lock.json ./
RUN npm pkg delete devDependencies.canvas && npm ci --onnxruntime-node-install-cuda=skip
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

# Install server dependencies and build. better-sqlite3 installs via its prebuilt binary (fast);
# we do NOT add a compiler toolchain — compiling SQLite from source on the 1-vCPU VPS takes ~50min
# and times out. If the prebuilt download flakes (GitHub 504), the deploy fails fast — just retry.
COPY server/package.json server/package-lock.json ./server/
RUN cd server && npm ci
COPY server/tsconfig.json ./server/
COPY server/src/ ./server/src/
RUN cd server && npm run build

# --- Production image ---
FROM node:22-alpine

WORKDIR /app

# ffmpeg: transcode MiMo's WAV output to MP3 for the TTS cache (smaller + universal playback)
# curl: used to POST audio to the whisper word-alignment endpoint (undici's proxy agent stalls on a
#       large request body; curl is reliable and goes direct on the VPS where there's no proxy)
RUN apk add --no-cache ffmpeg curl

# Server production deps only (better-sqlite3 via prebuilt binary — fast, no compile).
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
