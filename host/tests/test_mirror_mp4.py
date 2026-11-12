import struct
from pathlib import Path

import pytest

from drift_host.mirror.mp4 import ClipError, read_clip, read_samples

FIXTURES = Path(__file__).parent / "fixtures" / "mirror"


@pytest.mark.parametrize(("name", "codec"), [("h264.mp4", "h264"), ("hevc.mp4", "hevc")])
def test_reads_config_and_samples(name: str, codec: str) -> None:
    clip = read_clip(FIXTURES / name)
    assert (clip.config.codec, clip.config.width, clip.config.height) == (codec, 320, 180)
    assert len(clip.samples) == 15
    assert [s.keyframe for s in clip.samples].count(True) == 3  # gop 5
    assert clip.samples[0].keyframe and clip.samples[0].time == 0
    assert clip.samples[1].time == pytest.approx(1 / 30)


@pytest.mark.parametrize("name", ["h264.mp4", "hevc.mp4"])
def test_samples_are_length_prefixed_nal_units(name: str) -> None:
    clip = read_clip(FIXTURES / name)
    for data in read_samples(FIXTURES / name, clip.samples):
        at = 0
        while at < len(data):
            (length,) = struct.unpack_from(">I", data, at)
            assert length > 0
            at += 4 + length
        assert at == len(data)


def test_not_an_mp4_is_refused(tmp_path: Path) -> None:
    path = tmp_path / "x.mp4"
    path.write_bytes(b"\x00\x00\x00\x08free" * 4)
    with pytest.raises(ClipError):
        read_clip(path)


def test_truncated_file_is_refused(tmp_path: Path) -> None:
    data = (FIXTURES / "h264.mp4").read_bytes()
    path = tmp_path / "cut.mp4"
    path.write_bytes(data[: data.index(b"moov") + 200])
    with pytest.raises(ClipError):
        read_clip(path)


def test_box_claiming_more_than_its_parent_is_refused(tmp_path: Path) -> None:
    data = bytearray((FIXTURES / "h264.mp4").read_bytes())
    stsz = data.index(b"stsz") - 4
    struct.pack_into(">I", data, stsz, 0x7FFFFFFF)
    path = tmp_path / "bad.mp4"
    path.write_bytes(bytes(data))
    with pytest.raises(ClipError):
        read_clip(path)
