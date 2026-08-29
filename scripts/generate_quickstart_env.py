"""Regenerate .env.quickstart.example from the canonical quickstart profile."""

from pathlib import Path
import sys

PROJECT_ROOT = Path(__file__).resolve().parents[1]
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from src.core.config_profiles import render_quickstart_env  # noqa: E402


def main() -> None:
    (PROJECT_ROOT / ".env.quickstart.example").write_text(
        render_quickstart_env(),
        encoding="utf-8",
        newline="\n",
    )


if __name__ == "__main__":
    main()
