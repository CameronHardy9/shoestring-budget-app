#!/usr/bin/env bash
# Formats the file Claude just edited. Never blocks the edit (always exits 0).
# Requires jq. Adjust the formatters to match your stack.
FILE=$(jq -r '.tool_input.file_path // empty')
[ -z "$FILE" ] || [ ! -f "$FILE" ] && exit 0
case "$FILE" in
  *.ts|*.tsx|*.js|*.jsx|*.css|*.scss|*.html|*.json|*.yaml|*.yml)
    command -v npx >/dev/null && npx --no-install prettier --write "$FILE" >/dev/null 2>&1 ;;
  *.py)
    command -v ruff >/dev/null && ruff format "$FILE" >/dev/null 2>&1 ;;
  *.go)
    command -v gofmt >/dev/null && gofmt -w "$FILE" >/dev/null 2>&1 ;;
esac
exit 0
