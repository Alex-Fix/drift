from pathlib import Path

import pytest

from drift_host.protocol import ProtocolError, error, parse
from tests.conftest import FIXTURES, load


@pytest.mark.parametrize("path", sorted((FIXTURES / "valid").glob("*.json")), ids=lambda p: p.stem)
def test_valid_fixture_is_accepted_unchanged(path: Path) -> None:
    message = load(path)
    assert parse(message) == message


@pytest.mark.parametrize("path", sorted((FIXTURES / "invalid").glob("*.json")), ids=lambda p: p.stem)
def test_invalid_fixture_is_rejected_with_its_code(path: Path) -> None:
    expected = path.stem.split("--")[0]
    with pytest.raises(ProtocolError) as e:
        parse(load(path))
    assert e.value.code == expected


def test_boolean_is_not_a_number() -> None:
    with pytest.raises(ProtocolError):
        parse({"v": True, "type": "hello", "id": "1"})


def test_error_drops_an_id_that_is_not_a_valid_id() -> None:
    assert error("invalid_message", "x" * 65) == {"v": 1, "type": "error", "code": "invalid_message"}
    assert error("invalid_message", 7) == {"v": 1, "type": "error", "code": "invalid_message"}
