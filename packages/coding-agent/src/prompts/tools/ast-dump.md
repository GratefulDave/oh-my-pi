Dumps a tree-sitter syntax tree as an S-expression via native ast-grep parsing.

<instruction>
- Use when an `ast_grep` pattern fails to parse or misses expected code and you need node kinds/shape before changing the query
- Provide exactly one of `path` or `code`
- `path` accepts one file path or internal URL backed by a file; it does not scan directories or globs
- `code` requires `lang` because there is no file extension to infer from
- Use the dump to choose valid node kinds and pattern wrappers; do not guess from source text alone
</instruction>

<output>
- Parser language
- Whether the syntax tree contains error nodes
- Tree-sitter S-expression for the full input
</output>

<examples>
# Dump a file inferred from extension
`{"path":"src/server.ts"}`
# Dump inline TypeScript pattern context
`{"code":"class A { method(x: string): number { return 1 } }","lang":"typescript"}`
</examples>
