#!/usr/bin/env bash
# poll-pr2041.sh — Background poller for PR #2041 (feat: deterministic shell-output minimizer)
# Monitors review comments from roboomp/codex on can1357/oh-my-pi PR #2041.
# On new unresolved issues, invokes the coding agent to address them and pushes.
# Exits cleanly when the PR is merged or closed.
#
# Usage:  ./scripts/poll-pr2041.sh [--interval <seconds>] [--log <file>]
# Defaults: interval=120s, log=$REPO_ROOT/.omp/pr2041-poll.log

set -euo pipefail

REPO="can1357/oh-my-pi"
PR_NUMBER="2041"
PR_BRANCH="pr/minimizer"
REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
INTERVAL=120
LOG_FILE="$REPO_DIR/.omp/pr2041-poll.log"
STATE_FILE="$REPO_DIR/.omp/pr2041-seen-comments.json"

# Parse args
while [[ $# -gt 0 ]]; do
  case "$1" in
    --interval) INTERVAL="$2"; shift 2 ;;
    --log)      LOG_FILE="$2";  shift 2 ;;
    --help|-h)
      echo "Usage: $0 [--interval <seconds>] [--log <file>]"
      exit 0
      ;;
    *) echo "Unknown arg: $1" >&2; exit 1 ;;
  esac
done

mkdir -p "$(dirname "$LOG_FILE")" "$(dirname "$STATE_FILE")"

log() { local ts; ts="$(date '+%Y-%m-%d %H:%M:%S')"; echo "[$ts] $*" | tee -a "$LOG_FILE"; }

# Ensure gh is available
if ! command -v gh &>/dev/null; then
  echo "ERROR: gh CLI not found. Install from https://cli.github.com" >&2; exit 1
fi

# Ensure we're authenticated
gh api user &>/dev/null || { echo "ERROR: not authenticated with gh. Run: gh auth login" >&2; exit 1; }

log "=== PR #$PR_NUMBER poller starting (interval=${INTERVAL}s) ==="
log "Repo: $REPO_DIR | Branch: $PR_BRANCH | Log: $LOG_FILE"

# Load seen comment IDs (set of node IDs we've already processed)
load_seen() {
  if [[ -f "$STATE_FILE" ]]; then
    jq -r '.[]' "$STATE_FILE" 2>/dev/null || echo ""
  fi
}

save_seen() {
  # $1 = newline-separated list of IDs
  echo "$1" | jq -Rn '[inputs]' > "$STATE_FILE"
}

fetch_pr_state() {
  gh api "repos/$REPO/pulls/$PR_NUMBER" --jq '{state: .state, merged: .merged}' 2>/dev/null
}

fetch_review_comments() {
  # Returns JSON array of {id, node_id, author, body, path, line, resolved}
  gh api "repos/$REPO/pulls/$PR_NUMBER/comments" \
    --jq '[.[] | {
      id: .id,
      node_id: .node_id,
      author: .user.login,
      body: .body,
      path: .path,
      line: .line,
      created_at: .created_at
    }]' 2>/dev/null || echo "[]"
}

fetch_issue_comments() {
  gh api "repos/$REPO/issues/$PR_NUMBER/comments" \
    --jq '[.[] | {
      id: .id,
      node_id: .node_id,
      author: .user.login,
      body: .body,
      created_at: .created_at
    }]' 2>/dev/null || echo "[]"
}

# Check if a comment is actionable (from a reviewer bot/maintainer, not us)
is_actionable_reviewer() {
  local author="$1"
  [[ "$author" == "roboomp" || "$author" == "can1357" || "$author" == "chatgpt-codex-connector" ]]
}

# Extract blocking/should-fix comments from roboomp
has_blocking_keyword() {
  local body="$1"
  echo "$body" | grep -qiE '\*\*(blocking|should-fix|P[01])\*\*|BLOCKING:|SHOULD-FIX:'
}

# Synthesize an omp ask prompt to address new review feedback
build_fix_prompt() {
  local comments_json="$1"
  cat <<EOF
PR #2041 (feat(minimizer): deterministic shell-output minimizer) on $REPO has new unresolved review feedback.
Working directory: $REPO_DIR
Branch: $PR_BRANCH (pushed to origin/GratefulDave)

Review comments to address:
$comments_json

Instructions:
1. Read the relevant source files in crates/pi-shell and packages/ to understand the current state.
2. For each comment marked blocking or should-fix, implement the minimal correct fix.
3. Do NOT push antigravity-only changes (baseUrl fix, gain telemetry) to origin/$PR_BRANCH.
4. After making all fixes, commit with a descriptive message and run: git push origin HEAD:$PR_BRANCH
5. Verify: cargo check -p pi-shell -p pi-natives && cargo test -p pi-shell minimizer --lib
EOF
}

apply_fixes() {
  local new_comments_json="$1"
  log "Invoking coding agent to address ${2} new comment(s)..."

  local prompt
  prompt="$(build_fix_prompt "$new_comments_json")"
  local prompt_file
  prompt_file="$(mktemp /tmp/pr2041-prompt.XXXXXX.md)"
  echo "$prompt" > "$prompt_file"

  # Use omp ask if available, otherwise fall back to logging for manual action
  if command -v omp &>/dev/null; then
    log "Running: omp ask --file $prompt_file"
    cd "$REPO_DIR"
    omp ask --file "$prompt_file" 2>&1 | tee -a "$LOG_FILE" || {
      log "WARNING: omp ask exited non-zero — manual review may be needed"
    }
  else
    log "WARNING: omp not found. Prompt written to $prompt_file — address manually."
    log "Prompt content:"
    cat "$prompt_file" >> "$LOG_FILE"
  fi
  rm -f "$prompt_file"
}

# ── Main poll loop ─────────────────────────────────────────────────────────────

seen_ids="$(load_seen)"

while true; do
  # 1. Check PR state
  pr_state_json="$(fetch_pr_state)"
  pr_state="$(echo "$pr_state_json" | jq -r '.state // "open"')"
  pr_merged="$(echo "$pr_state_json" | jq -r '.merged // false')"

  if [[ "$pr_merged" == "true" ]]; then
    log "PR #$PR_NUMBER is MERGED. Polling complete."
    exit 0
  fi

  if [[ "$pr_state" == "closed" ]]; then
    log "PR #$PR_NUMBER is CLOSED (not merged). Polling stopped."
    exit 0
  fi

  log "PR #$PR_NUMBER is $pr_state — checking for new review comments..."

  # 2. Fetch all review/inline comments
  review_comments="$(fetch_review_comments)"
  issue_comments="$(fetch_issue_comments)"

  # Combine and find unseen actionable ones
  new_actionable_comments="$(
    echo "$review_comments" "$issue_comments" | jq -s '
      flatten |
      map(select(
        (.author == "roboomp" or .author == "can1357" or .author == "chatgpt-codex-connector[bot]") and
        (.body | test("\\*\\*(blocking|should-fix|P[01])\\*\\*|BLOCKING:|SHOULD-FIX:"; "i"))
      ))
    '
  )"

  # Filter to unseen
  unseen_count=0
  unseen_comments="[]"
  while IFS= read -r node_id; do
    [[ -z "$node_id" ]] && continue
    if ! echo "$seen_ids" | grep -qF "$node_id"; then
      unseen_count=$((unseen_count + 1))
      body="$(echo "$review_comments" "$issue_comments" | jq -s --arg nid "$node_id" 'flatten | map(select(.node_id == $nid)) | first')"
      unseen_comments="$(echo "$unseen_comments" | jq --argjson c "$body" '. + [$c]')"
    fi
  done < <(echo "$new_actionable_comments" | jq -r '.[].node_id')

  if [[ "$unseen_count" -gt 0 ]]; then
    log "Found $unseen_count new actionable comment(s) — applying fixes..."
    apply_fixes "$unseen_comments" "$unseen_count"

    # Mark all processed
    new_seen_ids="$(
      { echo "$seen_ids"; echo "$new_actionable_comments" | jq -r '.[].node_id'; } | sort -u
    )"
    save_seen "$new_seen_ids"
    seen_ids="$new_seen_ids"
  else
    log "No new actionable comments. Next check in ${INTERVAL}s..."
  fi

  sleep "$INTERVAL"
done
