#!/usr/bin/env bash
# Regression test: verify lex auth credentials are in the right place.
set -euo pipefail

LEX_DB="$HOME/.lex/agent/agent.db"
PI_AUTH="$HOME/.pi/agent/auth.json"
ACCOUNTS="$HOME/.config/opencode/antigravity-accounts.json"
NOW_MS=$(python3 -c "import time; print(int(time.time() * 1000))")
FAIL=0

check_oauth() {
  local provider="$1"
  local expires
  expires=$(sqlite3 "$LEX_DB" "SELECT json_extract(data,'$.expires') FROM auth_credentials WHERE provider='$provider'" 2>/dev/null)
  if [[ -z "$expires" ]]; then
    echo "FAIL [$provider] no credential in $LEX_DB"
    FAIL=1; return
  fi
  if [[ "$expires" -gt 0 && "$expires" -lt "$NOW_MS" ]]; then
    echo "FAIL [$provider] token expired ($expires < $NOW_MS)"
    FAIL=1
  else
    echo "OK   [$provider] credential present in DB"
  fi
}

check_row_exists() {
  local provider="$1"
  local count
  count=$(sqlite3 "$LEX_DB" "SELECT COUNT(*) FROM auth_credentials WHERE provider='$provider'" 2>/dev/null)
  if [[ "$count" -eq 0 ]]; then
    echo "FAIL [$provider] no row in $LEX_DB — tab will not appear"
    FAIL=1
  else
    echo "OK   [$provider] row present in DB"
  fi
}

echo "=== lex auth check ==="
echo ""

# 1. Env pin
if grep -q "PI_CODING_AGENT_DIR" "$HOME/.lex/agent/.env" 2>/dev/null; then
  echo "OK   [env] PI_CODING_AGENT_DIR pinned in ~/.lex/agent/.env"
else
  echo "FAIL [env] ~/.lex/agent/.env missing PI_CODING_AGENT_DIR — /login will write to wrong dir"
  FAIL=1
fi

# 2. openai-codex — full OAuth token managed by lex
check_oauth "openai-codex"

# 3. opencode-antigravity — row must exist; real token in ~/.config/opencode/antigravity-accounts.json
check_row_exists "opencode-antigravity"

# 4. Verify antigravity accounts file has active account with refresh token
if [[ -f "$ACCOUNTS" ]]; then
  python3 -c "
import json, sys
data = json.load(open('$ACCOUNTS'))
accs = data.get('accounts', [])
idx = data.get('activeIndex', 0)
active = accs[idx] if idx < len(accs) else None
if not active:
    print('FAIL [antigravity-accounts] no active account')
    sys.exit(1)
if not active.get('refreshToken'):
    print('FAIL [antigravity-accounts] active account missing refreshToken')
    sys.exit(1)
print(f'OK   [antigravity-accounts] active={active.get(\"email\",\"?\")} has refreshToken')
" || FAIL=1
else
  echo "FAIL [antigravity-accounts] $ACCOUNTS not found"
  FAIL=1
fi

# 5. Warn if pi auth.json has newer openai-codex token than lex DB
if [[ -f "$PI_AUTH" ]]; then
  PI_EXP=$(python3 -c "import json; d=json.load(open('$PI_AUTH')); print(d.get('openai-codex',{}).get('expires',0))" 2>/dev/null || echo 0)
  LEX_EXP=$(sqlite3 "$LEX_DB" "SELECT json_extract(data,'$.expires') FROM auth_credentials WHERE provider='openai-codex'" 2>/dev/null || echo 0)
  if [[ "$PI_EXP" -gt "${LEX_EXP:-0}" ]]; then
    echo "WARN [openai-codex] pi has newer token — run: python3 scripts/sync-pi-to-lex-auth.py"
  fi
fi

echo ""
[[ $FAIL -eq 0 ]] && echo "All checks passed." || { echo "Checks FAILED."; exit 1; }
