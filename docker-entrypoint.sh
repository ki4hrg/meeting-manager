#!/bin/sh
set -e
echo "Applying migrations…"
node ./dist/migrate.cjs
exec "$@"
