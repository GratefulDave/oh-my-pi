# ast_dump

> Single-file syntax tree dump for repairing ast-grep patterns.

## Source
- Entry: `packages/coding-agent/src/tools/ast-dump.ts`
- Model-facing prompt: `packages/coding-agent/src/prompts/tools/ast-dump.md`
- Native binding: `crates/pi-natives/src/ast.rs::ast_dump`

## Inputs

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `path` | `string` | Conditionally | One file path or internal URL with a backing file. Mutually exclusive with `code`; globs and directories are rejected. |
| `code` | `string` | Conditionally | Inline source code. Mutually exclusive with `path`; requires `lang`. |
| `lang` | `string` | Required for `code` | Language override. Optional for `path`, where extension inference is normally used. |

## Outputs
- One text block with `path` when applicable, parser `language`, `hasErrors`, then the tree-sitter S-expression.
- `details` contains `language`, `hasErrors`, optional `path`, and the full `tree`.

## Flow
1. The TS wrapper validates exactly one of `path` or `code`.
2. Path mode normalizes relative paths against the session cwd and resolves internal URLs through `InternalUrlRouter`; only backing files are accepted.
3. Code mode requires an explicit language because there is no file extension.
4. Native `ast_dump` parses the source with `SupportLang::ast_grep(...)`, reports whether any error nodes exist, and returns `root.get_inner_node().to_sexp()`.

## Notes
- Use this before retrying an `ast_grep` pattern when the AST shape is unclear.
- The output is intentionally raw tree-sitter S-expression rather than a custom pretty tree so it stays faithful to the parser.
