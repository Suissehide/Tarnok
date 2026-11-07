#!/usr/bin/env bash
#
# Depose l'atlas de la horde (derive du pack, jamais committe) sur MinIO :
# assets/tinyswords/derived/monsters.{png,json} -> bucket `tiny-swords`.
#
# Meme lecture de `.env` que fetch-assets.sh. La cle doit avoir `s3:PutObject` :
# l'acces anonyme du bucket n'a que `s3:GetObject`.
#
# Usage :
#   cp deploy/.env.example .env   # puis renseigner les MINIO_*
#   python3 tools/build_monster_atlas.py
#   ./tools/push-atlas.sh
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC="$ROOT/assets/tinyswords/derived"

# shellcheck disable=SC1091
[ -f "$ROOT/.env" ] && set -a && . "$ROOT/.env" && set +a

: "${MINIO_ENDPOINT:?MINIO_ENDPOINT manquant — voir deploy/.env.example}"
: "${MINIO_ACCESS_KEY:?MINIO_ACCESS_KEY manquant}"
: "${MINIO_SECRET_KEY:?MINIO_SECRET_KEY manquant}"
: "${MINIO_BUCKET:?MINIO_BUCKET manquant}"

PREFIX="${MINIO_PREFIX:-}"
REMOTE="$MINIO_BUCKET${PREFIX:+/$PREFIX}/derived"

for f in monsters.png monsters.json; do
  [ -f "$SRC/$f" ] || { echo "$SRC/$f manquant : lancer python3 tools/build_monster_atlas.py" >&2; exit 1; }
done
grep -q '"prescaled": true' "$SRC/monsters.json" || {
  echo "monsters.json n'est pas cuit (pas de \"prescaled\": true) : relancer l'outil." >&2
  exit 1
}

if command -v mc >/dev/null 2>&1; then
  mc alias set tarnok-minio "$MINIO_ENDPOINT" "$MINIO_ACCESS_KEY" "$MINIO_SECRET_KEY" >/dev/null
  mc cp "$SRC/monsters.png" "$SRC/monsters.json" "tarnok-minio/$REMOTE/"
elif command -v aws >/dev/null 2>&1; then
  for f in monsters.png monsters.json; do
    AWS_ACCESS_KEY_ID="$MINIO_ACCESS_KEY" \
    AWS_SECRET_ACCESS_KEY="$MINIO_SECRET_KEY" \
    AWS_DEFAULT_REGION=us-east-1 \
      aws --endpoint-url "$MINIO_ENDPOINT" s3 cp "$SRC/$f" "s3://$REMOTE/$f"
  done
else
  echo "Ni 'mc' ni 'aws' trouve. Installer l'un des deux :" >&2
  echo "  brew install minio/stable/mc     # ou : brew install awscli" >&2
  exit 1
fi

echo "Atlas depose sur $MINIO_ENDPOINT/$REMOTE (prescaled). Le front bascule seul en nearest."
