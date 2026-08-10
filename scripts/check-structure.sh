#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
for path in README.md LICENSE package.json extensions/dida-todo/index.ts extensions/dida-todo/README.md; do
  [[ -f "$path" ]] || { printf 'Missing required file: %s\n' "$path" >&2; exit 1; }
done
node -e 'const p=require("./package.json"); if(p.name!=="dida-todo") throw new Error("unexpected package name"); if(JSON.stringify(p.pi?.extensions)!==JSON.stringify(["./extensions/dida-todo"])) throw new Error("unexpected Pi manifest");'
if grep -RInE --exclude-dir=.git --exclude-dir=node_modules --exclude='*.md' --exclude='check-structure.sh' '(sk-[A-Za-z0-9_-]{16,}|gho_[A-Za-z0-9_]{16,}|-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----|access_token|refresh_token)' .; then
  printf 'Potential credential found.\n' >&2; exit 1
fi
printf 'Package structure check passed.\n'
