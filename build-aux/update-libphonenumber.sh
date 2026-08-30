#!/bin/bash
# Get the absolute path of the root repository directory
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

cd "$ROOT_DIR/src/vendor" || exit 1

npm init -y
npm install libphonenumber-js esbuild

cat << 'EOF' > entry.js
export * from 'libphonenumber-js/min';
EOF

npx esbuild entry.js --bundle --format=esm --outfile=libphonenumber-esm.js

rm -rf node_modules package.json package-lock.json entry.js
