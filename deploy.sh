#!/bin/bash
set -e

VPS_HOST="root@107.152.47.101"
VPS_DIR="/opt/dictprop"

echo "==> Building frontend..."
npm run build

echo "==> Building server..."
cd server && npm run build && cd ..

echo "==> Setting up VPS directory structure..."
ssh "$VPS_HOST" "mkdir -p $VPS_DIR/dist $VPS_DIR/server/dist $VPS_DIR/data"

echo "==> Syncing frontend dist..."
rsync -avz --delete dist/ "$VPS_HOST:$VPS_DIR/dist/"

echo "==> Syncing server dist + deps..."
rsync -avz --delete server/dist/ "$VPS_HOST:$VPS_DIR/server/dist/"
rsync -avz server/package.json server/package-lock.json "$VPS_HOST:$VPS_DIR/server/"

echo "==> Syncing Docker files..."
rsync -avz Dockerfile docker-compose.yml "$VPS_HOST:$VPS_DIR/"

echo "==> Creating .env on VPS (if not exists)..."
ssh "$VPS_HOST" "test -f $VPS_DIR/.env || cat > $VPS_DIR/.env << 'EOF'
DEEPINFRA_API_KEY=MSXF2RdyosANJ76ZRXVHLW3v7GLFN26c
PORT=3000
DATA_DIR=/app/data
EOF"

echo "==> Building and starting Docker container..."
ssh "$VPS_HOST" "cd $VPS_DIR && docker compose up -d --build"

echo "==> Waiting for server to start..."
sleep 5

echo "==> Verifying..."
curl -sf http://107.152.47.101:3000/api/health && echo " OK" || echo " FAILED"

echo "==> Done! App running at http://107.152.47.101:3000"
