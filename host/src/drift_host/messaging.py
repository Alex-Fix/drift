"""Chrome native-messaging framing: a 32-bit native-endian length, then that many bytes of UTF-8 JSON.

stdout carries messages and nothing else — a stray print() corrupts the stream, so logs go to a file (see cli.py).
"""

import json
import struct
import sys
import threading
from typing import BinaryIO

from drift_host.protocol import ProtocolError

MAX_INCOMING = 1024 * 1024  # Chrome allows 64 MiB towards the host; nothing we accept comes close.
MAX_OUTGOING = 1024 * 1024  # Chrome's limit towards the extension.

_HEADER = struct.Struct("=I")


def _reject_constant(name: str) -> object:
    raise ValueError(name)  # NaN / Infinity aren't JSON


def decode(payload: bytes) -> object:
    try:
        return json.loads(payload.decode("utf-8"), parse_constant=_reject_constant)
    except (UnicodeDecodeError, ValueError) as e:
        raise ProtocolError("invalid_message") from e


def encode(message: dict[str, object]) -> bytes:
    payload = json.dumps(message, ensure_ascii=False, separators=(",", ":"), allow_nan=False).encode("utf-8")
    if len(payload) > MAX_OUTGOING:
        raise ProtocolError("message_too_large")
    return _HEADER.pack(len(payload)) + payload


def read_frame(stream: BinaryIO) -> bytes | None:
    """The next payload, or None when the browser closed the pipe. Oversized or truncated frames end the session."""
    header = stream.read(_HEADER.size)
    if not header:
        return None
    if len(header) < _HEADER.size:
        raise EOFError("truncated header")
    (length,) = _HEADER.unpack(header)
    if length > MAX_INCOMING:
        raise ProtocolError("message_too_large")
    payload = stream.read(length)
    if len(payload) < length:
        raise EOFError("truncated payload")
    return payload


class Writer:
    """Writes whole frames; responses and events come from different tasks, so writes are serialised."""

    def __init__(self, stream: BinaryIO) -> None:
        self._stream = stream
        self._lock = threading.Lock()

    def send(self, message: dict[str, object]) -> None:
        frame = encode(message)
        with self._lock:
            self._stream.write(frame)
            self._stream.flush()


def binary_stdio() -> tuple[BinaryIO, BinaryIO]:
    if sys.platform == "win32":
        import msvcrt
        import os

        # Text mode would turn \n into \r\n inside our length-prefixed frames.
        msvcrt.setmode(sys.stdin.fileno(), os.O_BINARY)
        msvcrt.setmode(sys.stdout.fileno(), os.O_BINARY)
    return sys.stdin.buffer, sys.stdout.buffer
