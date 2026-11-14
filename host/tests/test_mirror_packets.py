import json
import struct
from pathlib import Path

import pytest
from cryptography.hazmat.primitives.ciphers.aead import ChaCha20Poly1305

from drift_host.mirror import packets
from drift_host.mirror.mp4 import read_clip
from drift_host.mirror.packets import FrameSealer, VideoConfig

FIXTURES = Path(__file__).parent / "fixtures" / "mirror"
# Bytes produced by the Phase 0 spike code that the Samsung accepted (the spike scripts aren't in the repo). Don't
# regenerate these without re-testing the result on a receiver.
GOLDEN = json.loads((FIXTURES / "golden.json").read_text())


def test_h264_codec_packet_matches_the_tv_verified_bytes() -> None:
    config = VideoConfig("h264", bytes.fromhex(GOLDEN["avcc"]), 320, 180)
    expected = GOLDEN["h264_codec_packet"]
    assert packets.codec_packet(config, expected["ts"]).hex() == expected["packet"]


def test_sealed_frames_match_the_tv_verified_bytes() -> None:
    sealer = FrameSealer(bytes.fromhex(GOLDEN["key"]))
    for frame in GOLDEN["frames"]:
        sealed = sealer.seal(bytes.fromhex(frame["payload"]), keyframe=frame["idr"], timestamp=frame["ts"])
        assert sealed.hex() == frame["packet"]


def test_sealed_frame_decrypts_with_the_header_as_associated_data() -> None:
    key = bytes(range(32))
    sealer = FrameSealer(key)
    sealer.seal(b"first", keyframe=True, timestamp=1)
    packet = sealer.seal(b"\x00\x00\x00\x01\x41", keyframe=False, timestamp=2)
    head, body = packet[: packets.HEADER_SIZE], packet[packets.HEADER_SIZE :]
    size, kind, flags = struct.unpack_from("<IBB", head)
    assert (size, kind, flags) == (5 + packets.TAG_SIZE, packets.TYPE_VIDEO, 0)
    nonce = bytes(4) + struct.pack("<Q", 1)  # second frame
    assert ChaCha20Poly1305(key).decrypt(nonce, body, head) == b"\x00\x00\x00\x01\x41"


def test_hvc1_box_matches_ffmpegs_box_without_the_optional_btrt() -> None:
    clip = read_clip(FIXTURES / "hevc.mp4")
    data = (FIXTURES / "hevc.mp4").read_bytes()
    start = data.index(b"hvc1") - 4
    (size,) = struct.unpack_from(">I", data, start)
    ffmpeg_box = data[start : start + size]
    hvcc_at = ffmpeg_box.index(b"hvcC") - 4
    (hvcc_size,) = struct.unpack_from(">I", ffmpeg_box, hvcc_at)
    expected = struct.pack(">I", 86 + hvcc_size) + ffmpeg_box[4:86] + ffmpeg_box[hvcc_at : hvcc_at + hvcc_size]
    assert packets.hvc1_box(clip.config.record, clip.config.width, clip.config.height) == expected


def test_hevc_codec_packet_puts_the_parameter_sets_where_receivers_look() -> None:
    clip = read_clip(FIXTURES / "hevc.mp4")
    packet = packets.codec_packet(clip.config, 7)
    payload = packet[packets.HEADER_SIZE :]
    size, kind, _, option, ts = struct.unpack_from("<IBBHQ", packet)
    assert (size, kind, option, ts) == (len(payload), packets.TYPE_CODEC, packets.OPTION_HEVC_CODEC, 7)
    assert payload[4:8] == b"hvc1"
    assert payload[0x75:0x79] == b"\xa0\x00\x01\x00"  # VPS array, as UxPlay's receiver expects
    assert not payload.endswith(b"\x02\x00\x00\x00")


@pytest.mark.parametrize("offset", [16, 40, 56])
def test_codec_packet_carries_the_frame_size_as_floats(offset: int) -> None:
    packet = packets.codec_packet(VideoConfig("h264", bytes.fromhex(GOLDEN["avcc"]), 1920, 1080), 0)
    assert struct.unpack_from("<ff", packet, offset) == (1920.0, 1080.0)
