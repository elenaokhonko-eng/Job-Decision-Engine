---
description: "Required conventions for Python scripts and tests in CrewPilot"
applyTo: '**/*.py'
---

# Python

These rules apply to all `.py` files in the repository, including `test-app/backend/` and any future automation scripts under `scripts/`.

## Version and tooling

* Target Python 3.11+ syntax.
* Use `uv` for dependency management when scripts have dependencies. Use PEP 723 inline metadata for single-file scripts.
* Format with `ruff format`. Lint with `ruff check`. Do not introduce `black` or `flake8` to the repo.

## Script organization

Order every executable script as follows:

1. Shebang: `#!/usr/bin/env python3`
2. Module docstring describing purpose, usage, and example.
3. PEP 723 inline script metadata block (if applicable).
4. `from __future__ import annotations` (when supporting older interpreters).
5. Imports in three groups separated by blank lines: standard library, third-party, local.
6. Constants and exit codes.
7. Module-level logger: `logger = logging.getLogger(__name__)`.
8. Helper functions.
9. `create_parser()` function.
10. `configure_logging(verbose)` function.
11. `run()` business logic.
12. `main()` entry point.
13. `if __name__ == "__main__": sys.exit(main())`.

## Entry points and exit codes

```python
EXIT_SUCCESS = 0  # Successful execution
EXIT_FAILURE = 1  # General failure
EXIT_ERROR = 2    # Arguments or configuration error
```

Reserve `130` for `KeyboardInterrupt` (SIGINT).

## CLI argument parsing

* Use `argparse` for simple scripts. Extract parser creation into a function for testability.
* Use `click` for complex CLIs with subcommands or interactive prompts.
* Use `type=Path` for file arguments and `action="store_true"` for boolean flags.

## Path handling

* Use `pathlib.Path` exclusively. Do not use `os.path`.
* Common patterns: `read_text(encoding="utf-8")`, `write_text(...)`, `mkdir(parents=True, exist_ok=True)`, `with_suffix`, `iterdir`, `glob`, `rglob`.

## Subprocess execution

* Use `subprocess.run(cmd, capture_output=True, text=True, check=True)`.
* Catch `subprocess.CalledProcessError` and `FileNotFoundError` separately. Log stderr before re-raising.
* Pass `cwd=` and `env=` explicitly. Do not mutate the global environment.

## Type hints

* Use built-in generics: `list[str]`, `dict[str, int]`. Do not import from `typing` for these.
* Use union pipe syntax: `str | Path`, `Path | None`.
* Use `Literal` for constrained string values.
* Use `Self` for fluent interfaces (Python 3.11+).
* Public functions declare argument and return types.

## Error handling

```python
def main() -> int:
    try:
        return run()
    except KeyboardInterrupt:
        print("\nInterrupted by user", file=sys.stderr)
        return 130
    except BrokenPipeError:
        sys.stderr.close()
        return 1
    except Exception as e:
        print(f"Error: {e}", file=sys.stderr)
        return 1
```

Custom exceptions can carry exit codes when domain-specific failures need distinct return values.

## Documentation

Use Google-style docstrings with `Args`, `Returns`, `Raises`, and `Example` sections for every public function and class. Module docstrings include description, usage, and at least one example.

## Logging

* Get a module-level logger via `logging.getLogger(__name__)`.
* Configure once in `configure_logging` early in `main`.
* Use `%`-style format strings with logger arguments: `logger.error("Failed: %s", value)` — not f-strings inside log calls.

## Testing

* Use `pytest`. Standardize on `pytest-mock` for mocking; do not mix `unittest.mock` patches.
* Test files live alongside the code under `tests/` directories.
* Test names read as a sentence: `def test_returns_empty_list_when_input_is_none():`.
* Use fixtures for setup. Avoid module-level state.

## Patterns to avoid

* `os.path.join`, `os.path.exists`. Use `pathlib`.
* Bare `except:`. Catch a specific exception or `Exception`.
* `print` for non-CLI output. Use `logger`.
* Mutable default arguments (`def f(items=[])`).
* `from module import *`.
* `typing.List`, `typing.Dict`, `typing.Optional`, `typing.Union`. Use built-in syntax.

> Brought to you by CrewPilot.
