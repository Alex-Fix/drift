"""Mirroring data-channel packets: a 128-byte header (little-endian), then the payload.

Formats from the Phase 0 spike (design doc, spike log); tests/test_mirror_packets.py checks them byte for byte against
the spike code the Samsung accepted.
"""

import struct
from dataclasses import dataclass
from typing import Literal

from cryptography.hazmat.primitives.ciphers.aead import ChaCha20Poly1305

HEADER_SIZE = 128
TAG_SIZE = 16

TYPE_VIDEO = 0
TYPE_CODEC = 1
TYPE_HEARTBEAT = 2

FLAG_IDR = 0x10
OPTION_HEARTBEAT = 0x001E  # bytes 6-7 = 1e 00
OPTION_H264_CODEC = 0x0116  # 16 01
OPTION_HEVC_CODEC = 0x011E  # 1e 01

# payload size, type, flags (0x10 = IDR), option, NTP timestamp (seconds << 32 | fraction)
_HEADER = struct.Struct("<IBBHQ")
_SIZE_OFFSETS = (16, 40, 56)  # source, source again, destination: width and height as float32 pairs
_H264_TRAILER = b"\x02\x00\x00\x00"  # needed after avcC (spike step 2); HEVC has none (step 3)


@dataclass(frozen=True)
class VideoConfig:
    """Decoder setup as encoders and MP4 files carry it: an avcC (H.264) or hvcC (HEVC) record."""

    codec: Literal["h264", "hevc"]
    record: bytes
    width: int
    height: int


def header(size: int, kind: int, *, flags: int = 0, option: int = 0, timestamp: int = 0) -> bytearray:
    """A zeroed 128-byte header with the common fields set."""
    packet = bytearray(HEADER_SIZE)
    _HEADER.pack_into(packet, 0, size, kind, flags, option, timestamp)
    return packet


def heartbeat() -> bytes:
    """Sent about once a second while mirroring; no payload."""
    return bytes(header(0, TYPE_HEARTBEAT, option=OPTION_HEARTBEAT))


def codec_packet(config: VideoConfig, timestamp: int) -> bytes:
    """Unencrypted decoder setup, sent before the first frame and before every keyframe."""
    if config.codec == "h264":
        payload, option = config.record + _H264_TRAILER, OPTION_H264_CODEC
    else:
        payload, option = hvc1_box(config.record, config.width, config.height), OPTION_HEVC_CODEC
    packet = header(len(payload), TYPE_CODEC, option=option, timestamp=timestamp)
    for offset in _SIZE_OFFSETS:
        struct.pack_into("<ff", packet, offset, float(config.width), float(config.height))
    return bytes(packet) + payload


def hvc1_box(hvcc: bytes, width: int, height: int) -> bytes:
    """An MP4 `hvc1` VisualSampleEntry holding the `hvcC` box: what the receiver expects as the HEVC codec payload.

    Its parameter-set arrays land at payload offset 0x75, where receivers look for them. ffmpeg's box (the one the
    spike sent) also carried an optional `btrt` box, which this one leaves out.
    """
    entry = (
        bytes(6)  # reserved
        + struct.pack(">H", 1)  # data_reference_index
        + bytes(16)  # pre_defined / reserved
        + struct.pack(">HHII", width, height, 0x00480000, 0x00480000)  # 72 dpi
        + bytes(4)  # reserved
        + struct.pack(">H", 1)  # frame_count
        + bytes(32)  # compressorname
        + struct.pack(">Hh", 0x0018, -1)  # depth, pre_defined
    )
    hvcc_box = struct.pack(">I4s", 8 + len(hvcc), b"hvcC") + hvcc
    return struct.pack(">I4s", 8 + len(entry) + len(hvcc_box), b"hvc1") + entry + hvcc_box


class FrameSealer:
    """Encrypts access units into video packets: ChaCha20-Poly1305 with the session's stream key, the 128-byte header
    as associated data, and a nonce of 4 zero bytes plus a little-endian frame counter starting at 0."""

    def __init__(self, key: bytes) -> None:
        self._aead = ChaCha20Poly1305(key)
        self._counter = 0

    def seal(self, access_unit: bytes, *, keyframe: bool, timestamp: int) -> bytes:
        """`access_unit`: NAL units, each prefixed with its 4-byte big-endian length."""
        packet_header = bytes(
            header(len(access_unit) + TAG_SIZE, TYPE_VIDEO, flags=FLAG_IDR if keyframe else 0, timestamp=timestamp)
        )
        nonce = bytes(4) + struct.pack("<Q", self._counter)
        self._counter += 1
        return packet_header + self._aead.encrypt(nonce, access_unit, packet_header)
