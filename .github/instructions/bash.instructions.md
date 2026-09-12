---
description: "Required conventions for Bash scripts in CrewPilot"
applyTo: '**/*.sh'
---

# Bash

These rules apply to every `.sh` file, including `scripts/release.sh`, `scripts/npm-publish.sh`, and `scripts/vsix-multiplatform-builder.sh`.

## Shebang and strict mode

Every executable script begins with:

```bash
#!/usr/bin/env bash
set -euo pipefail
IFS=$'\n\t'
```

* `-e` exits on any non-zero command.
* `-u` errors on unset variables.
* `-o pipefail` propagates failures through pipes.
* The `IFS` reset prevents word-splitting surprises.

## Quoting

* Always quote variable expansions: `"$var"`, `"$@"`, `"${array[@]}"`.
* Use double quotes for strings that need expansion. Use single quotes for literal strings.
* Quote command substitutions: `result="$(some_command)"`.
* Never quote the right side of `case` patterns.

## Variables and naming

* `lowercase_snake_case` for local and script-scoped variables.
* `UPPERCASE_SNAKE_CASE` for environment variables and exported constants.
* Use `local` inside functions for every non-exported variable.
* Use `readonly` for constants that must not be reassigned.

## Functions

* Declare with `function_name() { ... }`. Do not use the `function` keyword (POSIX-style is portable).
* Document non-trivial functions with a one-line comment above the declaration.
* Return success or failure via exit codes. Use `printf` to emit values, not `echo`, when output may contain backslashes or `-` prefixes.

## Error handling

* Trap signals when scripts create temp files: `trap cleanup EXIT INT TERM`.
* Check command availability before invoking: `command -v jq >/dev/null || { echo "jq required" >&2; exit 1; }`.
* Emit errors to stderr: `echo "error: ..." >&2`.
* Exit with meaningful codes: `0` success, `1` general failure, `2` argument or configuration error.

## Conditionals and tests

* Use `[[ ... ]]` for tests. Do not use the single-bracket `[ ... ]` form.
* Use `(( ... ))` for arithmetic.
* Prefer `case` over chains of `if`/`elif` for matching against fixed values.

## Loops and arrays

* Iterate arrays with `for item in "${array[@]}"`. The quotes matter.
* Use `mapfile -t` (or `readarray -t`) to read lines into an array. Do not pipe `for`.
* Avoid parsing `ls`. Use globs or `find -print0 | xargs -0`.

## Subshells and pipelines

* Prefer `$( ... )` over backticks for command substitution.
* Avoid useless `cat`. Use input redirection: `grep pattern <file`, not `cat file | grep pattern`.
* When a pipeline failure matters, ensure `pipefail` is set or check `${PIPESTATUS[@]}`.

## Linting

Every script must pass `shellcheck` cleanly. When a warning is intentionally ignored, add a `# shellcheck disable=SCxxxx` comment with a one-line justification.

## Patterns to avoid

* `eval` on untrusted input.
* Word-splitting unquoted variables containing paths or user input.
* `cd` without verifying success. Use `cd "$dir" || exit 1`.
* Hard-coded `/tmp` paths. Use `mktemp -d` and clean up via trap.
* `sleep` to wait for background work. Wait on the actual condition.
* `set +e` blocks that hide real failures. Handle the specific command's exit code instead.

## Example skeleton

```bash
#!/usr/bin/env bash
set -euo pipefail
IFS=$'\n\t'

readonly SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

usage() {
  cat <<EOF
Usage: $(basename "$0") [--option value]
EOF
}

main() {
  local input=""
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --input) input="$2"; shift 2 ;;
      -h|--help) usage; exit 0 ;;
      *) echo "unknown option: $1" >&2; usage; exit 2 ;;
    esac
  done

  [[ -n "$input" ]] || { echo "error: --input required" >&2; exit 2; }
  echo "Processing $input"
}

main "$@"
```

> Brought to you by CrewPilot.
