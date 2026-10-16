#!/usr/bin/env bash
#
# Recupere le pack Tiny Swords depuis MinIO vers assets/tinyswords/.
#
# Le depot est public et la licence Pixel Frog interdit la redistribution, meme
# apres modification (voir NOTICE-assets.md). Les assets vivent donc sur MinIO,
# dans le bucket `tiny-swords`, et `assets/tinyswords/` est dans .gitignore.
#
# Usage :
#   cp deploy/.env.example .env   # puis renseigner les MINIO_*
#   ./tools/fetch-assets.sh
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEST="$ROOT/assets/tinyswords"

# shellcheck disable=SC1091
[ -f "$ROOT/.env" ] && set -a && . "$ROOT/.env" && set +a

# ⚠️ MINIO_ENDPOINT est l'API S3, pas la console. Sur qwetle.fr :
#   console  https://minio.qwetle.fr   (repond 200 en HTML sur tout, meme faux)
#   API S3   https://s3.qwetle.fr      (celle-ci)
: "${MINIO_ENDPOINT:?MINIO_ENDPOINT manquant — voir deploy/.env.example}"
: "${MINIO_ACCESS_KEY:?MINIO_ACCESS_KEY manquant}"
: "${MINIO_SECRET_KEY:?MINIO_SECRET_KEY manquant}"
: "${MINIO_BUCKET:?MINIO_BUCKET manquant}"

# Prefixe optionnel dans le bucket. Vide = les assets sont a la racine.
PREFIX="${MINIO_PREFIX:-}"
REMOTE="$MINIO_BUCKET${PREFIX:+/$PREFIX}"

mkdir -p "$DEST"

if command -v mc >/dev/null 2>&1; then
  mc alias set tarnok-minio "$MINIO_ENDPOINT" "$MINIO_ACCESS_KEY" "$MINIO_SECRET_KEY" >/dev/null
  mc mirror --overwrite --remove "tarnok-minio/$REMOTE" "$DEST"
elif command -v aws >/dev/null 2>&1; then
  AWS_ACCESS_KEY_ID="$MINIO_ACCESS_KEY" \
  AWS_SECRET_ACCESS_KEY="$MINIO_SECRET_KEY" \
  AWS_DEFAULT_REGION=us-east-1 \
    aws --endpoint-url "$MINIO_ENDPOINT" s3 sync \
      "s3://$REMOTE" "$DEST" --delete
else
  echo "Ni 'mc' ni 'aws' trouve. Installer l'un des deux :" >&2
  echo "  brew install minio/stable/mc     # ou : brew install awscli" >&2
  exit 1
fi

echo "Assets synchronises dans $DEST ($(find "$DEST" -type f | wc -l | tr -d ' ') fichiers)."
