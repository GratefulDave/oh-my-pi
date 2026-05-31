#!/usr/bin/env bash
# Tier A safe-port cherry-pick driver.
# For each SHA: try pick; if conflict or empty → abort/skip and log deferred; else keep.
set -u

LOG=.omc/autopilot/cherry-tier-a.log
DEFERRED=.omc/autopilot/cherry-tier-a-deferred.log
: > "$LOG"
: > "$DEFERRED"

SHAS=(
  3ea4981ee   # vertex catalog
  e8b510160   # vertex raw predict
  ac7f6e4d1   # vertex anthropic_version
  9474e95cb   # shebang chmod
  6491fff8f   # strict auth-gateway
  3d5f0d886   # auth-broker logger
  c0c9049cc   # mcp sse bounded
  2266fdae8   # mcp disabled timeout
  230ca0840   # auth-gateway status precedence
  7e46c4483   # anthropic image downscale
  b4238b10d   # auth-gateway 429 usage-limit
  3c4023037   # heal leaked stream markup
  6fb1983fb   # EventLoopKeepalive Agent.prompt
  e46ee155a   # shared python kernel
  f6ca76728   # wafer pass/serverless
  af2011f5a   # inline setInterval
  1f38f8d99   # wafer catalog
  36d8d2eb3   # wafer thinking format
  aed34e9ed   # wafer cost
  f71e1db0c   # emit listener isolation
  674d9b00a   # codex gpt-5.5 web search
  c1fa0e9f5   # keepalive disposable
  5053a6a4d   # incomplete stop recovery
  cc258b175   # natives tarball
)

for sha in "${SHAS[@]}"; do
  short_msg=$(git log -1 --format='%s' "$sha")
  echo ">>> $sha $short_msg" | tee -a "$LOG"
  if git cherry-pick -x "$sha" >/tmp/cp.out 2>&1; then
    echo "    PICKED" | tee -a "$LOG"
  else
    # check for empty (already applied)
    if grep -q "previous cherry-pick is now empty" /tmp/cp.out; then
      git cherry-pick --skip >/dev/null 2>&1 || git cherry-pick --abort >/dev/null 2>&1
      echo "    EMPTY (already in fork)" | tee -a "$LOG"
    else
      git cherry-pick --abort >/dev/null 2>&1
      echo "    CONFLICT — deferred" | tee -a "$LOG"
      echo "$sha $short_msg" >> "$DEFERRED"
      cat /tmp/cp.out | head -20 >> "$LOG"
      echo "---" >> "$LOG"
    fi
  fi
done

echo
echo "=== SUMMARY ==="
echo "Picked:   $(grep -c '    PICKED'   "$LOG")"
echo "Empty:    $(grep -c '    EMPTY'    "$LOG")"
echo "Deferred: $(grep -c '    CONFLICT' "$LOG")"
