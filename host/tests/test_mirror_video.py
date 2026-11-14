import struct

import pytest

from drift_host.mirror import packets
from drift_host.mirror.clock import ntp_after, ntp_from_ns
from drift_host.mirror.packets import VideoConfig
from drift_host.mirror.video import VideoStream

CONFIG = VideoConfig("h264", b"\x01\x64\x00\x28\xff\xe1\x00\x01\x67\x01\x00\x01\x68", 1920, 1080)


class RecordingSession:
    stream_key = bytes(32)

    def __init__(self) -> None:
        self.sent: list[bytes] = []

    async def send(self, packet: bytes) -> None:
        self.sent.append(packet)


def kinds(session: RecordingSession) -> list[int]:
    return [p[4] for p in session.sent]


async def test_keyframes_carry_the_decoder_setup_first() -> None:
    session = RecordingSession()
    stream = VideoStream(session, CONFIG)  # type: ignore[arg-type]
    await stream.send(b"key", keyframe=True, timestamp=10)
    await stream.send(b"delta", keyframe=False, timestamp=11)
    await stream.send(b"key2", keyframe=True, timestamp=12)
    assert kinds(session) == [
        packets.TYPE_CODEC,
        packets.TYPE_VIDEO,
        packets.TYPE_VIDEO,
        packets.TYPE_CODEC,
        packets.TYPE_VIDEO,
    ]
    assert [struct.unpack_from("<Q", p, 8)[0] for p in session.sent] == [10, 10, 11, 12, 12]


async def test_stream_must_start_with_a_keyframe() -> None:
    stream = VideoStream(RecordingSession(), CONFIG)  # type: ignore[arg-type]
    with pytest.raises(ValueError, match="keyframe"):
        await stream.send(b"delta", keyframe=False, timestamp=1)


async def test_reconfigure_requires_a_keyframe_and_sends_the_new_setup() -> None:
    session = RecordingSession()
    stream = VideoStream(session, CONFIG)  # type: ignore[arg-type]
    await stream.send(b"key", keyframe=True, timestamp=1)
    stream.reconfigure(VideoConfig("h264", CONFIG.record, 1280, 720))
    with pytest.raises(ValueError):
        await stream.send(b"delta", keyframe=False, timestamp=2)
    await stream.send(b"key", keyframe=True, timestamp=3)
    assert struct.unpack_from("<ff", session.sent[-2], 16) == (1280.0, 720.0)


def test_ntp_conversion() -> None:
    assert ntp_from_ns(0) == 2_208_988_800 << 32
    assert ntp_from_ns(1_500_000_000) == (2_208_988_801 << 32) | (1 << 31)
    assert ntp_after(5 << 32, 0.5) == (5 << 32) | (1 << 31)
