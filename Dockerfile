# Every stage starts from one Node image, pinned by digest like the workflows' actions, so a new node:22-alpine
# release reaches production only through a reviewed edit of this line. To move on, read node:22-alpine's current
# index digest (`docker buildx imagetools inspect node:22-alpine`, or the registry API) and the exact version tag
# that carries it, and replace both here.
ARG NODE_IMAGE=node:22.23.5-alpine3.24@sha256:1314fb30ec37592d5845e5a160d522c0e680972aa534549940b8d73bde88481a

FROM ${NODE_IMAGE} AS whisper-builder

ARG WHISPER_CPP_VERSION=v1.9.1
ARG WHISPER_CPP_SOURCE_SHA256=147267177eef7b22ec3d2476dd514d1b12e160e176230b740e3d1bd600118447
ARG WHISPER_TINY_EN_SHA256=921e4cf8686fdd993dcd081a5da5b6c365bfde1162e72b08d75ac75289920b1f
RUN apk add --no-cache build-base cmake curl
# Built for the VPS CPU, not the GitHub runner that builds the image: AVX2, FMA and BMI2 stay off (abc4fc0).
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

# The client bundle. A change to server code doesn't touch this stage.
FROM ${NODE_IMAGE} AS client-build

WORKDIR /app

# Skip onnxruntime-node's GPU-binary download: the browser uses onnxruntime-WEB, never the Node
# build, but its postinstall fetches a large CUDA tarball from GitHub that intermittently 504s and
# breaks `npm ci` (which silently kept the old container running). Skipping it makes builds reliable.
ENV ONNXRUNTIME_NODE_INSTALL_CUDA=skip
COPY package.json package-lock.json ./
RUN npm ci
COPY index.html index.tsx tsconfig.json postcss.config.js ./
COPY App.tsx types.ts ./
COPY content/ ./content/
COPY src/ ./src/
COPY public/ ./public/
COPY views/ ./views/
COPY services/ ./services/
COPY components/ ./components/
COPY hooks/ ./hooks/
COPY vite.config.ts ./
RUN npm run build

# The server's JavaScript. A change to client code doesn't touch this stage. tsc needs only the packages'
# JavaScript and type definitions, so the install skips install scripts, better-sqlite3's download among them.
FROM ${NODE_IMAGE} AS server-build

WORKDIR /app/server

COPY server/package.json server/package-lock.json ./
RUN npm ci --ignore-scripts
COPY server/tsconfig.json server/tsconfig.build.json ./
COPY server/src/ ./src/
RUN npm run build

# --- Production image ---
FROM ${NODE_IMAGE}

WORKDIR /app

# ffmpeg: transcode MiMo's WAV output to MP3 for the TTS cache (smaller + universal playback)
# curl: proxyFetch uses it for large proxied JSON bodies; direct VPS requests still use native fetch.
RUN apk add --no-cache ffmpeg curl libstdc++ libgcc libgomp

COPY --from=whisper-builder /src/build/bin/whisper-cli /usr/local/bin/whisper-cli
COPY --from=whisper-builder /models/ggml-tiny.en.bin /opt/whisper/ggml-tiny.en.bin
RUN whisper-cli --version && test -s /opt/whisper/ggml-tiny.en.bin

# Server production deps only. better-sqlite3 installs from its prebuilt binary: there's no compiler toolchain
# (images are built on GitHub runners, and compiling SQLite takes far too long), so a failed download (a GitHub
# 504) fails the build fast, and a retry fixes it. The npm cache stays out of the image.
COPY server/package.json server/package-lock.json ./server/
RUN cd server && npm ci --omit=dev && rm -rf /root/.npm

COPY --from=server-build /app/server/dist/ ./server/dist/
COPY --from=client-build /app/dist/ ./dist/
# The server reads only these two catalogs from content/.
COPY content/essay-catalog.json content/real-life-catalog.json ./content/

RUN mkdir -p /app/data

EXPOSE 3000

ENV NODE_ENV=production
ENV PORT=3000
ENV DATA_DIR=/app/data

# Shows in `docker ps` whether the server answers. Docker only reports it: the restart policy ignores it, and
# deploys keep their own health gate. The app still runs as root, because host-side root jobs (the deploy's
# fallback backup among them) create files in ./data that a non-root server couldn't then open.
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:' + (process.env.PORT || 3000) + '/api/health', { signal: AbortSignal.timeout(4000) }).then(r => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]

CMD ["node", "server/dist/index.js"]
