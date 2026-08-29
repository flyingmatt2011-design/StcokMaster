from pathlib import Path

from src.core.config_profiles import QUICKSTART_FIELDS, render_quickstart_env
from src.core.config_registry import get_registered_field_keys


def test_quickstart_template_is_generated_and_uses_registered_keys():
    project_root = Path(__file__).resolve().parents[1]
    committed = (project_root / ".env.quickstart.example").read_text(encoding="utf-8")

    assert committed.replace("\r\n", "\n") == render_quickstart_env()
    registered = set(get_registered_field_keys())
    assert {field.key for field in QUICKSTART_FIELDS} <= registered
