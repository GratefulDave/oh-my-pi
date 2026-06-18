#!/usr/bin/env python3
"""
Copy openai-codex (and optionally other) credentials from ~/.pi/agent/auth.json
into ~/.lex/agent/agent.db when pi has a fresher token.

Usage: python3 scripts/sync-pi-to-lex-auth.py [--force] [provider ...]
  --force   copy even if lex token is not expired
  provider  providers to sync (default: openai-codex)
"""
import argparse, json, sqlite3, sys, time
from pathlib import Path

PI_AUTH = Path.home() / ".pi/agent/auth.json"
LEX_DB  = Path.home() / ".lex/agent/agent.db"

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--force", action="store_true")
    parser.add_argument("providers", nargs="*", default=["openai-codex"])
    args = parser.parse_args()

    if not PI_AUTH.exists():
        sys.exit(f"FAIL: {PI_AUTH} not found")
    if not LEX_DB.exists():
        sys.exit(f"FAIL: {LEX_DB} not found")

    pi_auth = json.loads(PI_AUTH.read_text())
    db = sqlite3.connect(str(LEX_DB))
    now_ms = int(time.time() * 1000)

    for provider in args.providers:
        cred = pi_auth.get(provider)
        if not cred:
            print(f"SKIP [{provider}] not in pi auth.json")
            continue

        pi_exp = cred.get("expires", 0)
        if pi_exp < now_ms:
            print(f"SKIP [{provider}] pi token also expired ({pi_exp} < {now_ms})")
            continue

        row = db.execute(
            "SELECT json_extract(data,'$.expires') FROM auth_credentials WHERE provider=?",
            (provider,)
        ).fetchone()
        lex_exp = row[0] if row else 0

        if not args.force and lex_exp and lex_exp >= now_ms:
            print(f"OK   [{provider}] lex token still valid (expires {lex_exp}), skipping")
            continue

        data = json.dumps(cred)
        db.execute(
            "INSERT OR REPLACE INTO auth_credentials (provider, credential_type, disabled_cause, data) VALUES (?,?,?,?)",
            (provider, "oauth", None, data)
        )
        db.commit()
        days = (pi_exp - now_ms) // 86_400_000
        print(f"SYNC [{provider}] copied from pi → lex (valid ~{days}d)")

    db.close()

if __name__ == "__main__":
    main()
