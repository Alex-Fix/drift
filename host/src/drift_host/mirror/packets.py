"""Mirroring data-channel packets: a 128-byte header (little-endian), then the payload."""

import struct

HEADER_SIZE = 128

TYPE_VIDEO = 0
TYPE_CODEC = 1
TYPE_HEARTBEAT = 2

OPTION_HEARTBEAT = 0x001E  # bytes 6-7 = 1e 00

# payload size, type, flags (0x10 = IDR), option, NTP timestamp (seconds << 32 | fraction)
_HEADER = struct.Struct("<IBBHQ")


def header(size: int, kind: int, *, flags: int = 0, option: int = 0, timestamp: int = 0) -> bytearray:
    """A zeroed 128-byte header with the common fields set; codec packets add their size floats themselves."""
    packet = bytearray(HEADER_SIZE)
    _HEADER.pack_into(packet, 0, size, kind, flags, option, timestamp)
    return packet


def heartbeat() -> bytes:
    """Sent about once a second while mirroring; no payload."""
    return bytes(header(0, TYPE_HEARTBEAT, option=OPTION_HEARTBEAT))
