#!/usr/bin/env bash
# Back up a Weft: a compressed dump of its database plus a copy of the stack's .env (needed to restore:
# ASSIST_MASTER_KEY decrypts the saved model keys), checked, with old backups pruned.
#
#   tools/backup.sh            the real Weft (stacks/weft/.env)
#   tools/backup.sh --test     the test stack
#
# Settings, from the environment or stacks/weft/.env:
#   BACKUP_DIR        where backups go (default ~/weft-backups); kept private (0700 / 0600)
#   BACKUP_KEEP_DAYS  how many days of backups to keep (default 14)
#   BACKUP_COPY_TO    optional second copy over ssh, as host:directory (pruned the same way there)
# Exits non-zero if anything fails, so a scheduler can alert. Restore: see the admin wiki, Operations.
set -euo pipefail
repo="$(cd "$(dirname "$0")/.." && pwd)"
. "$repo/tools/docker.sh"
if [ "${1:-}" = "--test" ]; then
  envfile="$repo/stacks/weft-test/.env"
  DC=("${DOCKER[@]}" compose -p weft-test -f "$repo/stacks/weft/compose.yaml" -f "$repo/stacks/weft-test/compose.test.yaml" --env-file "$envfile")
else
  envfile="$repo/stacks/weft/.env"
  project=$(sed -n 's/^WEFT_PROJECT=//p' "$envfile" | tail -1)
  DC=("${DOCKER[@]}" compose -p "${project:-weft-core}" -f "$repo/stacks/weft/compose.yaml" --env-file "$envfile")
fi
setting() { local v; v="${!1:-}"; [ -n "$v" ] || v=$(sed -n "s/^$1=//p" "$envfile" | tail -1); printf '%s' "${v:-$2}"; }
dir=$(setting BACKUP_DIR "$HOME/weft-backups"); keep=$(setting BACKUP_KEEP_DAYS 14); copy=$(setting BACKUP_COPY_TO "")

umask 077
mkdir -p "$dir"; chmod 700 "$dir"
stamp=$(date +%Y%m%d-%H%M%S)
dump="$dir/weft-$stamp.dump"
"${DC[@]}" exec -T postgres pg_dump -U weft_owner -Fc weft > "$dump.part"
# A dump that pg_restore can list, with the core tables' data in it, counts as good.
listing=$("${DC[@]}" exec -T postgres pg_restore -l < "$dump.part") || { echo "backup check failed: the dump cannot be read" >&2; rm -f "$dump.part"; exit 1; }
tables=$(grep -c "TABLE DATA" <<< "$listing" || true)
for t in users spaces members messages items; do
  grep -q "TABLE DATA weft $t " <<< "$listing" || { echo "backup check failed: no data for $t" >&2; rm -f "$dump.part"; exit 1; }
done
mv "$dump.part" "$dump"
cp "$envfile" "$dir/weft-$stamp.env"
find "$dir" -maxdepth 1 -name 'weft-*' -type f -mtime "+$keep" -delete
size=$(du -h "$dump" | cut -f1)
if [ -n "$copy" ]; then
  host="${copy%%:*}"; rdir="${copy#*:}"
  ssh -o BatchMode=yes -o ConnectTimeout=15 "$host" "umask 077; mkdir -p '$rdir' && chmod 700 '$rdir'"
  scp -q -B -p "$dump" "$dir/weft-$stamp.env" "$host:$rdir/"
  ssh -o BatchMode=yes "$host" "find '$rdir' -maxdepth 1 -name 'weft-*' -type f -mtime +$keep -delete"
  echo "backup ok: $dump ($size, $tables tables), copied to $copy"
else
  echo "backup ok: $dump ($size, $tables tables)"
fi
