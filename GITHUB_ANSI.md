# GitHub CLI ANSI JSON issue

## Symptom

OMP/lex reads GitHub CLI output as machine data, but the shell environment can force color output and warnings into command output. When that happens, `gh --json ...` output may contain ANSI escape sequences or preamble text, so OMP JSON parsing fails.

## Observed local cause

Current shell environment includes conflicting color variables:

```text
FORCE_COLOR=1
CLICOLOR_FORCE=1
NO_COLOR=1
TERM=dumb
```

`~/.zshrc` currently sets this inside cmux shells:

```zsh
if [[ -n "$CMUX_SHELL_INTEGRATION" ]]; then
  export FORCE_COLOR=1
  export CLICOLOR_FORCE=1
fi
```

That was intended to preserve ANSI for human-facing pane output, but it is unsafe for machine-readable subprocesses. `NO_COLOR=1` does not win when `FORCE_COLOR=1` is also present; Bun/Node can emit warnings such as:

```text
Warning: The 'NO_COLOR' env is ignored due to the 'FORCE_COLOR' env being set.
```

Any warning or ANSI byte before/inside JSON breaks strict readers.

## Safe rule

Keep the fix scoped to OMP/lex only.

- Do not change OMP/lex core code for this local environment issue.
- Do not remove cmux-wide forced color if Claude, Codex, or other pane tools need it.
- Do not globally wrap `gh`; that would affect unrelated shells/tools.
- Do sanitize `gh` only inside the OMP/lex process tree.

## Applied local fix

`~/.zshrc` keeps the existing cmux color behavior, but `omp` and `lex` now launch with a scoped `PATH` prefix:

```zsh
_omp_with_clean_gh() {
  PATH="$HOME/.local/share/omp-gh-clean-path:$PATH" command "$@"
}

omp() {
  _omp_with_clean_gh omp "$@"
}

lex() {
  _omp_with_clean_gh lex "$@"
}
```

The only executable in that prefix is `~/.local/share/omp-gh-clean-path/gh`:

```sh
#!/bin/sh
unset FORCE_COLOR
unset CLICOLOR_FORCE
unset GH_FORCE_TTY
exec /opt/homebrew/bin/gh "$@"
```

Effect:

- `omp` / `lex` internal GitHub CLI reads use the clean `gh` shim.
- Claude, Codex, and normal shell commands keep the existing color environment.
- OMP/lex source code is unchanged.

## Verification

A clean GitHub JSON call should start with `{` and contain no escape byte (`0x1b`):

```sh
env -u FORCE_COLOR -u CLICOLOR_FORCE -u GH_FORCE_TTY NO_COLOR=1 TERM=dumb \
  gh repo view can1357/oh-my-pi --json nameWithOwner | python3 -m json.tool >/dev/null
```

Check for ANSI bytes:

```sh
env -u FORCE_COLOR -u CLICOLOR_FORCE -u GH_FORCE_TTY NO_COLOR=1 TERM=dumb \
  gh repo view can1357/oh-my-pi --json nameWithOwner | LC_ALL=C grep $'\033' && echo 'ANSI found' || echo 'clean'
```

Expected result: JSON parses and the ANSI check prints `clean`.
