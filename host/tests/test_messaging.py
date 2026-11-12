import io
import struct

import pytest

from drift_host import messaging
from drift_host.protocol import ProtocolError


def frame(payload: bytes) -> bytes:
    return struct.pack("=I", len(payload)) + payload


def test_frame_round_trips() -> None:
    encoded = messaging.encode({"v": 1, "type": "hello", "id": "1"})
    assert messaging.decode(messaging.read_frame(io.BytesIO(encoded)) or b"") == {"v": 1, "type": "hello", "id": "1"}


def test_closed_pipe_reads_as_none() -> None:
    assert messaging.read_frame(io.BytesIO(b"")) is None


def test_oversized_message_is_rejected_before_reading_it() -> None:
    stream = io.BytesIO(struct.pack("=I", messaging.MAX_INCOMING + 1))
    with pytest.raises(ProtocolError) as e:
        messaging.read_frame(stream)
    assert e.value.code == "message_too_large"


def test_truncated_payload_ends_the_session() -> None:
    with pytest.raises(EOFError):
        messaging.read_frame(io.BytesIO(struct.pack("=I", 10) + b"{}"))


@pytest.mark.parametrize("payload", [b"\xff\xfe", b"{", b'{"v": NaN}'])
def test_undecodable_payload_is_invalid(payload: bytes) -> None:
    with pytest.raises(ProtocolError) as e:
        messaging.decode(payload)
    assert e.value.code == "invalid_message"


def test_oversized_outgoing_message_is_refused() -> None:
    with pytest.raises(ProtocolError):
        messaging.encode({"v": 1, "type": "ok", "id": "x" * messaging.MAX_OUTGOING})
