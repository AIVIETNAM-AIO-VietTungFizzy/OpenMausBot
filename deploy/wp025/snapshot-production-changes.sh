#!/usr/bin/env bash
# Copies a checkout's uncommitted changes out of it, without writing inside the checkout.
# Usage: snapshot-production-changes.sh [checkout] [expected-base-commit]
set -euo pipefail

repo="${1:-$HOME/workspace/OpenMausBot}"
expected_base="${2:-f55d45c6e0764ec78e5ba8b0427150656dc94c92}"
out_root="${OMB_SNAPSHOT_DIR:-$HOME/omb-release-snapshots}"

# git status refreshes .git/index unless optional locks are off (git 2.15+).
export GIT_OPTIONAL_LOCKS=0
umask 077

case "$out_root" in
  "$repo"|"$repo"/*) echo "OMB_SNAPSHOT_DIR must be outside the checkout" >&2; exit 2 ;;
esac

cd "$repo"
git rev-parse --is-inside-work-tree >/dev/null
head="$(git rev-parse HEAD)"
out="$out_root/wp025-$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$out"
if [ "$head" != "$expected_base" ]; then
  echo "WARNING: HEAD is $head, not the expected base $expected_base. Re-plan the integration on this base." >&2
fi

{
  echo "checkout: $repo"
  echo "head: $head"
  echo "expected_base: $expected_base"
  echo "branch: $(git symbolic-ref --short -q HEAD || echo '(detached)')"
  echo "taken_at_utc: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "host: $(hostname)"
  echo "git: $(git --version)"
  echo "node: $(node --version 2>/dev/null || echo 'not on PATH')"
  echo "remotes:"
  git remote -v | sed -E 's#://[^/@]+@#://REDACTED@#'
} > "$out/base.txt"

git status --porcelain=v1 --untracked-files=all > "$out/status.txt"
git diff --binary HEAD > "$out/tracked.patch"
git diff --binary --cached > "$out/staged.patch"
git diff --stat HEAD > "$out/tracked.stat"
git ls-files --others --ignored --exclude-standard --directory > "$out/ignored-inventory.txt"

excluded='(^|/)(\.env[^/]*|[^/]*\.(pem|key|p12|pfx|db|sqlite[^/]*|log)|id_(rsa|ed25519|ecdsa)[^/]*|[^/]*(credential|secret)[^/]*|node_modules|dist|data)(/|$)'
git ls-files --others --exclude-standard > "$out/untracked-all.txt"
grep -Ev "$excluded" "$out/untracked-all.txt" > "$out/untracked-copied.txt" || true
grep -E "$excluded" "$out/untracked-all.txt" > "$out/untracked-not-copied.txt" || true

secret='(sk-[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{20,}|xox[abpr]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|-----BEGIN [A-Z ]*PRIVATE KEY-----|(api[_-]?key|secret|password|passwd|token|bearer)["'"'"']?[[:space:]]*[:=][[:space:]]*["'"'"'][^"'"'"'[:space:]]{8,})'
hits="$out/secret-scan-hits.txt"
: > "$hits"
grep -EinI "$secret" "$out/tracked.patch" | cut -d: -f1 | sed 's/^/tracked.patch line /' >> "$hits" || true
while IFS= read -r file; do
  [ -f "$file" ] || continue
  grep -EinI "$secret" "$file" | cut -d: -f1 | sed "s#^#$file line #" >> "$hits" || true
done < "$out/untracked-copied.txt"

if [ -s "$hits" ] && [ "${OMB_SNAPSHOT_ACCEPT_SCAN_HITS:-}" != "1" ]; then
  echo "Secret-like text found; nothing was archived. Locations (no values) are in $hits" >&2
  echo "Review each location. Only if every one is a false positive, run again with OMB_SNAPSHOT_ACCEPT_SCAN_HITS=1." >&2
  rm -f "$out/tracked.patch" "$out/staged.patch"
  exit 3
fi

if [ -s "$out/untracked-copied.txt" ]; then
  tr '\n' '\0' < "$out/untracked-copied.txt" | tar --null -T - -czf "$out/untracked.tar.gz"
fi

# macOS ships shasum; Linux ships sha256sum.
if command -v sha256sum >/dev/null; then sum=(sha256sum); else sum=(shasum -a 256); fi
(cd "$out" && "${sum[@]}" ./*.patch ./*.txt ./*.stat $( [ -f untracked.tar.gz ] && echo untracked.tar.gz ) > SHA256SUMS)

echo "Snapshot: $out"
if [ -s "$hits" ]; then
  echo "Accepted secret-scan hits are listed in $hits; clear each before anything from this snapshot is committed." >&2
fi
echo "Tracked changes:"
cat "$out/tracked.stat"
echo "Untracked files copied: $(grep -c '' "$out/untracked-copied.txt" || true)"
echo "Untracked files left out (names only, review them): $(grep -c '' "$out/untracked-not-copied.txt" || true)"
