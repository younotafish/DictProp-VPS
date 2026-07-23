FROM node:22-alpine AS whisper-builder

ARG WHISPER_CPP_VERSION=v1.9.1
ARG WHISPER_CPP_SOURCE_SHA256=147267177eef7b22ec3d2476dd514d1b12e160e176230b740e3d1bd600118447
ARG WHISPER_TINY_EN_SHA256=921e4cf8686fdd993dcd081a5da5b6c365bfde1162e72b08d75ac75289920b1f
RUN apk add --no-cache build-base cmake curl
RUN mkdir -p /src /models \
  && curl -fsSL --retry 5 --retry-delay 5 \
    "https://github.com/ggml-org/whisper.cpp/archive/refs/tags/${WHISPER_CPP_VERSION}.tar.gz" \
    -o /tmp/whisper.cpp.tar.gz \
  && echo "${WHISPER_CPP_SOURCE_SHA256}  /tmp/whisper.cpp.tar.gz" | sha256sum -c - \
  && tar -xzf /tmp/whisper.cpp.tar.gz -C /src --strip-components=1 \
  && cmake -S /src -B /src/build -DCMAKE_BUILD_TYPE=Release -DBUILD_SHARED_LIBS=OFF \
    -DGGML_NATIVE=OFF -DGGML_AVX2=OFF -DGGML_FMA=OFF -DGGML_BMI2=OFF \
    -DWHISPER_BUILD_TESTS=OFF -DWHISPER_BUILD_SERVER=OFF \
  && cmake --build /src/build --config Release --target whisper-cli -j2 \
  && curl -fsSL --retry 5 --retry-delay 5 \
    https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-tiny.en.bin \
    -o /models/ggml-tiny.en.bin \
  && echo "${WHISPER_TINY_EN_SHA256}  /models/ggml-tiny.en.bin" | sha256sum -c -

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
# curl: proxyFetch uses it for large proxied JSON bodies; direct VPS requests still use native fetch.
RUN apk add --no-cache ffmpeg curl libstdc++ libgcc libgomp

COPY --from=whisper-builder /src/build/bin/whisper-cli /usr/local/bin/whisper-cli
COPY --from=whisper-builder /models/ggml-tiny.en.bin /opt/whisper/ggml-tiny.en.bin
RUN whisper-cli --version && test -s /opt/whisper/ggml-tiny.en.bin

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
