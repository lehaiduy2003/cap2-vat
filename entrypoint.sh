#!/bin/sh
set -e

echo "Running DB migrations..."
# Node/pg cần ssl khi nói chuyện Railway
# export NODE_TLS_REJECT_UNAUTHORIZED=0
npm run migration:run

echo "Start app..."
npm start
