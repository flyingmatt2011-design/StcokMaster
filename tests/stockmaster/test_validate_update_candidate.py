from pathlib import Path

from scripts.stockmaster.validate_update_candidate import validate_candidate


def test_valid_candidate_only_changes_allowlisted_backend_files(tmp_path: Path):
    current = tmp_path / "current"
    candidate = tmp_path / "candidate"
    (current / "src").mkdir(parents=True)
    (candidate / "src").mkdir(parents=True)
    (current / "src" / "analyzer.py").write_text("VALUE = 1\n", encoding="utf-8")
    (candidate / "src" / "analyzer.py").write_text("VALUE = 2\n", encoding="utf-8")
    result = validate_candidate(current, candidate, ["src/analyzer.py"], [])
    assert result["ok"] is True
    assert result["changed_paths"] == ["src/analyzer.py"]


def test_candidate_rejects_ui_and_user_data_files(tmp_path: Path):
    current = tmp_path / "current"
    candidate = tmp_path / "candidate"
    (current / "src").mkdir(parents=True)
    (candidate / "src").mkdir(parents=True)
    (candidate / "apps" / "dsa-web").mkdir(parents=True)
    (candidate / "data").mkdir(parents=True)
    (candidate / "src" / "analyzer.py").write_text("VALUE = 2\n", encoding="utf-8")
    (candidate / "apps" / "dsa-web" / "App.tsx").write_text("export {}", encoding="utf-8")
    (candidate / "data" / "stock_analysis.db").write_bytes(b"not-user-data")
    result = validate_candidate(current, candidate, ["src/analyzer.py"], [])
    assert result["ok"] is False
    assert "apps/dsa-web/App.tsx" in result["blocked_paths"]
    assert "data/stock_analysis.db" in result["blocked_paths"]
