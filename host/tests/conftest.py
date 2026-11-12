import json
from pathlib import Path

FIXTURES = Path(__file__).resolve().parents[2] / "protocol" / "fixtures"


def load(path: Path) -> object:
    return json.loads(path.read_text(encoding="utf-8"))
