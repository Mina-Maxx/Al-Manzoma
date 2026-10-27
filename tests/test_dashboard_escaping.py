from __future__ import annotations

import shutil
import subprocess
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
ESCAPE_TEST = ROOT / "tests" / "dashboard" / "views_escape_test.mjs"


def test_dashboard_views_escape_user_supplied_fields():
    """Render views with `<script>` and `"><img onerror>` payloads and prove the
    output contains no live tags (runs the real view helpers under Node)."""
    node = shutil.which("node")
    if node is None:
        pytest.skip(
            "node is not installed; dashboard view escaping could not be exercised"
        )

    result = subprocess.run(
        [node, str(ESCAPE_TEST)],
        capture_output=True,
        text=True,
        cwd=str(ROOT),
    )
    assert result.returncode == 0, result.stdout + result.stderr
