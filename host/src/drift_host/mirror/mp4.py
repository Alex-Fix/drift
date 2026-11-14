"""Reads the first video track of a plain (non-fragmented) MP4: decoder setup and sample table.

For `drift-host mirror-file`: MP4 carries the same avcC/hvcC record and length-prefixed access units that the
browser's encoder will produce, so a clip exercises the same video path. H.264 (`avc1`/`avc3`) and HEVC
(`hvc1`/`hev1`) only; clips with B-frames are refused (mirroring sends frames in display order).
"""

import struct
from collections.abc import Iterator
from dataclasses import dataclass
from pathlib import Path
from typing import BinaryIO

from drift_host.mirror.packets import VideoConfig

_CODECS = {
    b"avc1": ("h264", b"avcC"),
    b"avc3": ("h264", b"avcC"),
    b"hvc1": ("hevc", b"hvcC"),
    b"hev1": ("hevc", b"hvcC"),
}
_MAX_TABLE = 10_000_000  # entries; bounds memory on a malformed file


class ClipError(Exception):
    """The file isn't an MP4 drift can play."""


@dataclass(frozen=True)
class Sample:
    offset: int
    size: int
    keyframe: bool
    time: float  # seconds from the first sample


@dataclass(frozen=True)
class Clip:
    config: VideoConfig
    samples: list[Sample]


def read_clip(path: Path) -> Clip:
    with path.open("rb") as f:
        size = f.seek(0, 2)
        moov = _find(f, 0, size, b"moov")
        if moov is None:
            raise ClipError("no moov box (fragmented or not an MP4)")
        for trak_start, trak_end in _children(f, *moov, b"trak"):
            clip = _video_track(f, trak_start, trak_end)
            if clip is not None:
                return clip
    raise ClipError("no H.264 or HEVC video track")


def read_samples(path: Path, samples: list[Sample]) -> Iterator[bytes]:
    with path.open("rb") as f:
        for sample in samples:
            f.seek(sample.offset)
            data = f.read(sample.size)
            if len(data) != sample.size:
                raise ClipError("sample data runs past the end of the file")
            yield data


def _video_track(f: BinaryIO, start: int, end: int) -> Clip | None:
    mdia = _find(f, start, end, b"mdia")
    if mdia is None:
        return None
    hdlr = _find(f, *mdia, b"hdlr")
    if hdlr is None or _read(f, hdlr[0] + 8, 4) != b"vide":
        return None
    timescale = _timescale(f, mdia)
    stbl = _path(f, mdia, [b"minf", b"stbl"])
    config = _sample_description(f, stbl)
    sizes = _sizes(f, stbl)
    offsets = _offsets(f, stbl, sizes)
    times = _times(f, stbl, len(sizes), timescale)
    keyframes = _keyframes(f, stbl, len(sizes))
    if _has_reordering(f, stbl):
        raise ClipError("clip has B-frames; re-encode without them (e.g. ffmpeg -bf 0)")
    samples = [
        Sample(offset, size, i in keyframes if keyframes is not None else True, time)
        for i, (offset, size, time) in enumerate(zip(offsets, sizes, times, strict=True))
    ]
    if not samples or not samples[0].keyframe:
        raise ClipError("clip doesn't start with a keyframe")
    return Clip(config, samples)


# ---- tables -------------------------------------------------------------------------------------------------------


def _timescale(f: BinaryIO, mdia: tuple[int, int]) -> int:
    mdhd = _require(f, mdia, b"mdhd")
    version = _read(f, mdhd[0], 1)[0]
    (timescale,) = struct.unpack(">I", _read(f, mdhd[0] + (20 if version == 1 else 12), 4))
    if timescale == 0:
        raise ClipError("zero timescale")
    return int(timescale)


def _sample_description(f: BinaryIO, stbl: tuple[int, int]) -> VideoConfig:
    stsd = _require(f, stbl, b"stsd")
    entry_start = stsd[0] + 8  # full-box header + entry_count
    entry_size, kind = struct.unpack(">I4s", _read(f, entry_start, 8))
    if kind not in _CODECS:
        raise ClipError(f"unsupported codec {kind.decode('latin-1')!r}")
    codec, record_kind = _CODECS[kind]
    width, height = struct.unpack(">HH", _read(f, entry_start + 32, 4))
    record = _find(f, entry_start + 86, min(stsd[1], entry_start + entry_size), record_kind)
    if record is None:
        raise ClipError(f"no {record_kind.decode()} record")
    data = _read(f, record[0], record[1] - record[0])
    length_size = (data[4] & 3) + 1 if codec == "h264" else (data[21] & 3) + 1 if len(data) > 21 else 0
    if length_size != 4:
        raise ClipError("only 4-byte NAL length prefixes are supported")
    return VideoConfig(codec, data, width, height)  # type: ignore[arg-type]  # codec is from _CODECS


def _sizes(f: BinaryIO, stbl: tuple[int, int]) -> list[int]:
    stsz = _require(f, stbl, b"stsz")
    uniform, count = struct.unpack(">II", _read(f, stsz[0] + 4, 8))
    _check_count(count)
    if uniform:
        return [uniform] * count
    return list(struct.unpack(f">{count}I", _read(f, stsz[0] + 12, 4 * count)))


def _offsets(f: BinaryIO, stbl: tuple[int, int], sizes: list[int]) -> list[int]:
    count = len(sizes)
    stco, wide = _find(f, *stbl, b"stco"), False
    if stco is None:
        stco, wide = _require(f, stbl, b"co64"), True
    (chunks,) = struct.unpack(">I", _read(f, stco[0] + 4, 4))
    _check_count(chunks)
    chunk_offsets = struct.unpack(
        f">{chunks}{'Q' if wide else 'I'}", _read(f, stco[0] + 8, (8 if wide else 4) * chunks)
    )
    stsc = _require(f, stbl, b"stsc")
    (entries,) = struct.unpack(">I", _read(f, stsc[0] + 4, 4))
    _check_count(entries)
    runs = [struct.unpack(">III", _read(f, stsc[0] + 8 + 12 * i, 12)) for i in range(entries)]
    offsets: list[int] = []
    for i, (first_chunk, per_chunk, _) in enumerate(runs):
        last_chunk = runs[i + 1][0] - 1 if i + 1 < len(runs) else chunks
        for chunk in range(first_chunk, last_chunk + 1):
            if not 1 <= chunk <= chunks:
                raise ClipError("sample-to-chunk table points past the chunk table")
            position = chunk_offsets[chunk - 1]
            for _ in range(per_chunk):
                if len(offsets) == count:
                    return offsets
                offsets.append(position)
                position += sizes[len(offsets) - 1]
    if len(offsets) != count:
        raise ClipError("sample tables disagree on the number of samples")
    return offsets


def _times(f: BinaryIO, stbl: tuple[int, int], count: int, timescale: int) -> list[float]:
    stts = _require(f, stbl, b"stts")
    (entries,) = struct.unpack(">I", _read(f, stts[0] + 4, 4))
    _check_count(entries)
    times: list[float] = []
    ticks = 0
    for i in range(entries):
        run, delta = struct.unpack(">II", _read(f, stts[0] + 8 + 8 * i, 8))
        for _ in range(run):
            if len(times) == count:
                break
            times.append(ticks / timescale)
            ticks += delta
    if len(times) != count:
        raise ClipError("time table disagrees on the number of samples")
    return times


def _keyframes(f: BinaryIO, stbl: tuple[int, int], count: int) -> set[int] | None:
    stss = _find(f, *stbl, b"stss")
    if stss is None:
        return None  # every sample is a keyframe
    (entries,) = struct.unpack(">I", _read(f, stss[0] + 4, 4))
    _check_count(entries)
    numbers = struct.unpack(f">{entries}I", _read(f, stss[0] + 8, 4 * entries))
    return {n - 1 for n in numbers if 1 <= n <= count}


def _has_reordering(f: BinaryIO, stbl: tuple[int, int]) -> bool:
    ctts = _find(f, *stbl, b"ctts")
    if ctts is None:
        return False
    (entries,) = struct.unpack(">I", _read(f, ctts[0] + 4, 4))
    _check_count(entries)
    offsets = {struct.unpack(">Ii", _read(f, ctts[0] + 8 + 8 * i, 8))[1] for i in range(entries)}
    return len(offsets) > 1  # a constant offset is just a delay, not reordering


# ---- boxes --------------------------------------------------------------------------------------------------------


def _read(f: BinaryIO, at: int, n: int) -> bytes:
    f.seek(at)
    data = f.read(n)
    if len(data) != n:
        raise ClipError("truncated file")
    return data


def _boxes(f: BinaryIO, start: int, end: int) -> Iterator[tuple[bytes, int, int]]:
    """(kind, content start, content end) for each box in [start, end)."""
    at = start
    while at + 8 <= end:
        size, kind = struct.unpack(">I4s", _read(f, at, 8))
        content = at + 8
        if size == 1:
            (size,) = struct.unpack(">Q", _read(f, at + 8, 8))
            content = at + 16
        elif size == 0:
            size = end - at
        if size < content - at or at + size > end:
            raise ClipError("malformed box")
        yield kind, content, at + size
        at += size


def _find(f: BinaryIO, start: int, end: int, kind: bytes) -> tuple[int, int] | None:
    for found, content, box_end in _boxes(f, start, end):
        if found == kind:
            return content, box_end
    return None


def _children(f: BinaryIO, start: int, end: int, kind: bytes) -> Iterator[tuple[int, int]]:
    for found, content, box_end in _boxes(f, start, end):
        if found == kind:
            yield content, box_end


def _path(f: BinaryIO, box: tuple[int, int], kinds: list[bytes]) -> tuple[int, int]:
    for kind in kinds:
        box = _require(f, box, kind)
    return box


def _require(f: BinaryIO, box: tuple[int, int], kind: bytes) -> tuple[int, int]:
    found = _find(f, *box, kind)
    if found is None:
        raise ClipError(f"missing {kind.decode('latin-1')} box")
    return found


def _check_count(count: int) -> None:
    if count > _MAX_TABLE:
        raise ClipError("sample table too large")
