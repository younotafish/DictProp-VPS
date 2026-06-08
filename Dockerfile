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

# Install server dependencies and build. better-sqlite3 is a native module with no reliable musl
# (Alpine) prebuilt, so install the toolchain to build it from source instead of a flaky download.
COPY server/package.json server/package-lock.json ./server/
RUN apk add --no-cache python3 make g++ && cd server && npm ci
COPY server/tsconfig.json ./server/
COPY server/src/ ./server/src/
RUN cd server && npm run build
# Strip dev deps but keep the already-compiled native modules — this becomes the prod node_modules,
# so better-sqlite3 is compiled ONCE (here) and just copied into the prod image below.
RUN cd server && npm prune --omit=dev

# --- Production image ---
FROM node:22-alpine

WORKDIR /app

# ffmpeg: transcode MiMo's WAV output to MP3 for the TTS cache (smaller + universal playback)
RUN apk add --no-cache ffmpeg

# Reuse the production server deps already built in the builder (better-sqlite3 compiled once there),
# so the prod image needs no toolchain and no second compile — just a fast copy.
COPY server/package.json ./server/
COPY --from=builder /app/server/node_modules/ ./server/node_modules/

# Copy built artifacts from builder
COPY --from=builder /app/server/dist/ ./server/dist/
COPY --from=builder /app/dist/ ./dist/

RUN mkdir -p /app/data

EXPOSE 3000

ENV PORT=3000
ENV DATA_DIR=/app/data

CMD ["node", "server/dist/index.js"]
