#!/usr/bin/env bash
# Nightly copy of the AgroTwin database (accounts, fields, flights, results),
# taken consistently while the app runs; the last AGROTWIN_BACKUP_KEEP_DAYS
# days are kept. Photos and maps are big files on disk: back up
# AGROTWIN_DATA_DIR with the university's file backup instead.
set -euo pipefail
DATA="${AGROTWIN_DATA_DIR:-/srv/agrotwin/data}"
DEST="${AGROTWIN_BACKUP_DIR:-/srv/agrotwin/backups}"
KEEP_DAYS="${AGROTWIN_BACKUP_KEEP_DAYS:-14}"
mkdir -p "$DEST"
out="$DEST/agrotwin-$(date +%Y%m%d-%H%M).db"
python3 - "$DATA/agrotwin.db" "$out" <<'PY'
import sqlite3, sys
src, dst = sqlite3.connect(sys.argv[1]), sqlite3.connect(sys.argv[2])
with dst:
    src.backup(dst)
dst.close()
src.close()
PY
gzip -f "$out"
find "$DEST" -name 'agrotwin-*.db.gz' -mtime +"$KEEP_DAYS" -delete
echo "backup: $out.gz"
