import io
import sys

import pytest

from drift_host.cli import main


def test_developer_commands_survive_a_console_that_isnt_utf8(monkeypatch: pytest.MonkeyPatch) -> None:
    raw = io.BytesIO()
    console = io.TextIOWrapper(raw, encoding="cp1252", newline="\n")  # Windows' default console encoding
    monkeypatch.setattr(sys, "stdout", console)
    with pytest.raises(SystemExit):
        main(["--version"])
    print("→ playing")  # what stream-url prints; would raise UnicodeEncodeError without the fix
    console.flush()
    assert raw.getvalue().endswith(b"? playing\n")
