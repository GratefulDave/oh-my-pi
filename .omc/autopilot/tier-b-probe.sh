#!/usr/bin/env bash
# Probe each Tier B SHA: which files conflict?
set -u
SHAS=(3ea4981ee e8b510160 ac7f6e4d1 6491fff8f 3d5f0d886 c0c9049cc 2266fdae8 b4238b10d 6fb1983fb e46ee155a af2011f5a 674d9b00a c1fa0e9f5 5053a6a4d)
OUT=.omc/autopilot/tier-b-conflicts.md
echo "# Tier B Conflict Surface" > "$OUT"
echo "" >> "$OUT"
for sha in "${SHAS[@]}"; do
  msg=$(git log -1 --format='%s' "$sha")
  files_changed=$(git show --stat --format='' "$sha" | sed '$d' | awk '{print $1}' | grep -v '^$')
  echo "## $sha" >> "$OUT"
  echo "$msg" >> "$OUT"
  echo "" >> "$OUT"
  echo '```' >> "$OUT"
  echo "Files touched upstream:" >> "$OUT"
  echo "$files_changed" >> "$OUT"
  echo "" >> "$OUT"
  echo "Fork status of those paths:" >> "$OUT"
  while IFS= read -r f; do
    [ -z "$f" ] && continue
    if [ -e "$f" ]; then
      fork_commits=$(git log --oneline HEAD -- "$f" 2>/dev/null | wc -l | tr -d ' ')
      echo "  $f  (fork commits touching: $fork_commits)"
    else
      echo "  $f  (MISSING in fork)"
    fi
  done <<< "$files_changed" >> "$OUT"
  echo '```' >> "$OUT"
  echo "" >> "$OUT"
done
echo "Done → $OUT"
