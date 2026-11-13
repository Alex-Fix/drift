import asyncio
import contextlib
import struct

import pytest

from drift_host.mirror import packets
from drift_host.mirror.session import MirrorError, MirrorSession, Timings
from tests.fake_tv import FAST, FakeTV, eventually


def stream_setup(tv: FakeTV) -> dict[str, object]:
    body = next(b for m, _, b in tv.requests if b and "streams" in b)
    streams = body["streams"]
    assert isinstance(streams, list) and isinstance(streams[0], dict)
    stream: dict[str, object] = streams[0]
    return stream


async def test_start_follows_the_verified_handshake_order() -> None:
    async with FakeTV() as tv:
        session = MirrorSession(tv, timings=FAST)
        await session.start()
        assert tv.log[:5] == ["session SETUP", "events opened", "stream SETUP", "data connected", "RECORD"]
        assert tv.events_port == 50001
        await session.stop()


async def test_session_setup_asks_for_screen_mirroring_with_our_timing_port() -> None:
    async with FakeTV() as tv:
        session = MirrorSession(tv, timings=FAST)
        await session.start()
        _, _, body = tv.requests[0]
        assert body is not None
        assert body["isScreenMirroringSession"] is True
        assert body["timingProtocol"] == "NTP"
        assert body["timingPort"] == tv.timing_port
        await session.stop()


async def test_stream_setup_is_a_screen_stream_with_fresh_keys_and_the_derived_stream_key() -> None:
    async with FakeTV() as tv:
        session = MirrorSession(tv, latency_ms=120, timings=FAST)
        await session.start()
        stream = stream_setup(tv)
        assert stream["type"] == 110
        assert stream["latencyMs"] == 120
        assert isinstance(stream["shk"], bytes) and len(stream["shk"]) == 32
        assert isinstance(stream["shiv"], bytes) and len(stream["shiv"]) == 16
        stream_id = stream["streamConnectionID"]
        assert isinstance(stream_id, int) and 0 <= stream_id < 2**63
        assert session.stream_key == tv.stream_key(stream_id)
        await session.stop()


async def test_record_is_skipped_when_the_receiver_says_so() -> None:
    async with FakeTV(skip_record=True) as tv:
        session = MirrorSession(tv, timings=FAST)
        await session.start()
        assert "RECORD" not in tv.log
        await session.stop()


@pytest.mark.parametrize("step", ["session SETUP", "stream SETUP", "RECORD"])
async def test_a_refused_step_fails_start_and_releases_the_receiver(step: str) -> None:
    async with FakeTV(refuse=step) as tv:
        session = MirrorSession(tv, timings=FAST)
        with pytest.raises(MirrorError, match="refused"):
            await session.start()
        assert tv.closed
        assert "TEARDOWN" not in tv.log  # nothing was recording yet


async def test_heartbeats_flow_on_the_data_connection() -> None:
    async with FakeTV() as tv:
        session = MirrorSession(tv, timings=FAST)
        await session.start()
        await eventually(lambda: len(tv.received) >= 2 * packets.HEADER_SIZE)
        await session.stop()
        first = bytes(tv.received[: packets.HEADER_SIZE])
        size, kind, _, option = struct.unpack_from("<IBBH", first)
        assert (size, kind, option) == (0, packets.TYPE_HEARTBEAT, packets.OPTION_HEARTBEAT)


async def test_feedback_is_posted_while_mirroring() -> None:
    async with FakeTV() as tv:
        session = MirrorSession(tv, timings=FAST)
        await session.start()
        await eventually(lambda: tv.log.count("POST /feedback") >= 2)
        await session.stop()


async def test_stop_does_not_hang_on_an_unanswered_teardown_and_closes_everything() -> None:
    async with FakeTV() as tv:
        session = MirrorSession(tv, timings=FAST)
        await session.start()
        async with asyncio.timeout(1):
            await session.stop()
        assert "TEARDOWN" in tv.log
        assert tv.closed
        await asyncio.wait_for(tv.data_eof.wait(), 1)
        assert session.ended.is_set()


async def test_stop_is_idempotent() -> None:
    async with FakeTV(answer_teardown=True) as tv:
        session = MirrorSession(tv, timings=FAST)
        await session.start()
        await session.stop()
        await session.stop()
        assert tv.log.count("TEARDOWN") == 1


async def test_sent_packets_reach_the_receiver() -> None:
    async with FakeTV() as tv:
        session = MirrorSession(tv, timings=Timings(heartbeat=60, feedback=60, teardown=0.1))
        await session.start()
        await session.send(b"\x01" * 300)
        await eventually(lambda: len(tv.received) >= 300)
        await session.stop()
        assert bytes(tv.received[:300]) == b"\x01" * 300


async def test_receiver_closing_the_data_connection_ends_the_session() -> None:
    async with FakeTV() as tv:
        session = MirrorSession(tv, timings=FAST)
        await session.start()
        tv.drop_data_connection()
        await asyncio.wait_for(session.ended.wait(), 1)
        with pytest.raises(MirrorError):
            await session.send(b"frame")
        await session.stop()


async def test_send_before_start_is_refused() -> None:
    async with FakeTV() as tv:
        with pytest.raises(MirrorError):
            await MirrorSession(tv, timings=FAST).send(b"frame")
        with contextlib.suppress(RuntimeError), pytest.raises(RuntimeError):
            _ = MirrorSession(tv).stream_key


async def test_losing_the_control_connection_during_teardown_still_closes_everything() -> None:
    async with FakeTV(lose_connection_on="TEARDOWN") as tv:
        session = MirrorSession(tv, timings=FAST)
        await session.start()
        await session.stop()
        assert tv.closed
        await asyncio.wait_for(tv.data_eof.wait(), 1)


async def test_failing_feedback_does_not_end_the_session() -> None:
    async with FakeTV(lose_connection_on="POST /feedback") as tv:
        session = MirrorSession(tv, timings=FAST)
        await session.start()
        await eventually(lambda: tv.log.count("POST /feedback") >= 3)
        assert not session.ended.is_set()
        await session.stop()


async def test_audio_stream_is_set_up_after_video_and_before_the_data_connection() -> None:
    async with FakeTV() as tv:
        session = MirrorSession(tv, audio=True, timings=FAST)
        await session.start()
        assert tv.log[:6] == [
            "session SETUP", "events opened", "stream SETUP", "audio SETUP", "data connected", "RECORD",
        ]  # fmt: skip
        await session.stop()


async def test_audio_setup_asks_for_the_verified_realtime_stream() -> None:
    async with FakeTV() as tv:
        session = MirrorSession(tv, audio=True, timings=FAST)
        await session.start()
        body = next(b for m, _, b in tv.requests if b and "streams" in b and b["streams"][0]["type"] == 96)  # type: ignore[index]
        stream = body["streams"][0]  # type: ignore[index]
        assert {k: stream[k] for k in ("ct", "audioFormat", "spf", "sr", "latencyMin")} == {
            "ct": 2, "audioFormat": 0x40000, "spf": 352, "sr": 44100, "latencyMin": 11025,
        }  # fmt: skip
        assert stream["shk"] == session.audio.key and len(session.audio.key) == 32
        assert stream["controlPort"] == tv.sender_control_port
        await session.stop()


async def test_refused_audio_setup_fails_start() -> None:
    async with FakeTV(refuse="audio SETUP") as tv:
        session = MirrorSession(tv, audio=True, timings=FAST)
        with pytest.raises(MirrorError, match="audio"):
            await session.start()
        assert tv.closed


async def test_session_without_audio_has_no_audio_channel() -> None:
    async with FakeTV() as tv:
        session = MirrorSession(tv, timings=FAST)
        await session.start()
        assert "audio SETUP" not in tv.log
        with pytest.raises(RuntimeError):
            _ = session.audio
        await session.stop()


async def test_stop_tears_down_the_stream_before_the_session() -> None:
    async with FakeTV(answer_teardown=True) as tv:
        session = MirrorSession(tv, timings=FAST)
        await session.start()
        await session.stop()
        assert tv.log[-2:] == ["stream TEARDOWN", "TEARDOWN"]
