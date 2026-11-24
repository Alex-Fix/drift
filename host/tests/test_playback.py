import asyncio

import pytest

from drift_host.playback import (
    CLIENT_TYPE,
    PlaybackError,
    PlaybackSession,
    State,
    Timings,
    buffered_ahead,
    cmtime,
    seconds,
)
from tests.fake_tv import FakeTV, eventually

FAST = Timings(reply=0.2, teardown=0.1)
URL = "https://media.example/video.m3u8"


def ms(value: int) -> dict[str, object]:
    return {"value": value, "timescale": 1000, "flags": 1, "epoch": 0}


async def started(tv: FakeTV, **kwargs: object) -> PlaybackSession:
    session = PlaybackSession(tv, timings=FAST, **kwargs)  # type: ignore[arg-type]
    await session.start()
    return session


async def loaded(tv: FakeTV) -> tuple[PlaybackSession, str]:
    session = await started(tv)
    await session.load(URL, "streaming")
    item = tv.commands[0][0]["item"]
    assert isinstance(item, dict) and isinstance(item["uuid"], str)
    return session, item["uuid"]


async def test_start_follows_the_verified_order() -> None:
    async with FakeTV() as tv:
        session = await started(tv)
        assert tv.log == ["session SETUP", "events opened", "RECORD", "playback SETUP"]
        assert tv.events_port == 50001
        await session.stop()


async def test_session_setup_is_not_mirroring_and_uses_our_ntp_timing_port() -> None:
    async with FakeTV() as tv:
        session = await started(tv)
        _, _, body = tv.requests[0]
        assert body is not None
        assert "isScreenMirroringSession" not in body
        assert body["timingProtocol"] == "NTP"
        assert body["timingPort"] == tv.timing_port
        await session.stop()


async def test_the_playback_stream_is_a_remote_control_stream() -> None:
    async with FakeTV() as tv:
        session = await started(tv)
        _, _, body = tv.requests[2]
        assert body is not None and isinstance(body["streams"], list)
        stream = body["streams"][0]
        assert stream["type"] == 130
        assert stream["controlType"] == 1
        assert stream["clientTypeUUID"] == CLIENT_TYPE
        assert str(stream["channelID"]).endswith("-RCS-1")
        await session.stop()


@pytest.mark.parametrize("step", ["session SETUP", "RECORD", "playback SETUP"])
async def test_a_refused_step_fails_start_and_releases_the_receiver(step: str) -> None:
    async with FakeTV(refuse=step) as tv:
        session = PlaybackSession(tv, timings=FAST)
        with pytest.raises(PlaybackError, match="refused"):
            await session.start()
        assert tv.closed


async def test_load_queues_the_item_then_plays_it() -> None:
    async with FakeTV() as tv:
        session = await started(tv)
        await session.load(URL, "file", position=12.5)
        assert tv.command_types() == ["insertPlayQueueItem", "setProperty", "setProperty", "setRate"]
        payload, command_session, stream_id = tv.commands[0]
        assert payload["item"] == {
            "uuid": payload["item"]["uuid"],  # type: ignore[index]
            "mediaType": "file",
            "Content-Location": URL,
            "Start-Position": ms(12500),
        }
        assert stream_id == 5
        assert all(s == command_session for _, s, _ in tv.commands)
        assert tv.commands[3][0] == {"type": "setRate", "rate": 1.0}
        await session.stop()


async def test_pause_and_resume_set_the_rate() -> None:
    async with FakeTV() as tv:
        session, _ = await loaded(tv)
        await session.pause()
        await session.resume()
        assert [p for p, _, _ in tv.commands[-2:]] == [
            {"type": "setRate", "rate": 0.0},
            {"type": "setRate", "rate": 1.0},
        ]
        await session.stop()


async def test_seek_asks_for_an_exact_jump_and_returns_where_the_receiver_landed() -> None:
    async with FakeTV(answers={"seek": {"position": ms(60000)}}) as tv:
        session, item = await loaded(tv)
        assert await session.seek(60) == 60.0
        payload = tv.commands[-1][0]
        assert payload["time"] == ms(60000)
        assert payload["toleranceBefore"] == payload["toleranceAfter"] == ms(0)
        assert payload["item"] == {"uuid": item}
        assert payload["kind"] == "request" and isinstance(payload["messageID"], int)
        await session.stop()


async def test_seek_before_load_is_an_error() -> None:
    async with FakeTV() as tv:
        session = await started(tv)
        with pytest.raises(PlaybackError, match="nothing loaded"):
            await session.seek(10)
        await session.stop()


async def test_info_reads_the_answer_from_the_event_channel() -> None:
    info = {
        "playbackState": "playing",
        "rate": 1,
        "position": ms(64846),
        "duration": ms(600000),
        "loadedTimeRanges": [{"start": ms(0), "duration": ms(24000)}, {"start": ms(60000), "duration": ms(30000)}],
    }
    async with FakeTV(answers={"playbackInfo": {"info": info}}) as tv:
        session, _ = await loaded(tv)
        result = await session.info()
        assert result.state == "playing"
        assert result.rate == 1.0
        assert result.position == pytest.approx(64.846)
        assert result.duration == 600.0
        assert result.buffered == pytest.approx(25.154)
        await session.stop()


async def test_an_unanswered_request_times_out() -> None:
    async with FakeTV(answers={}) as tv:
        session, _ = await loaded(tv)
        with pytest.raises(PlaybackError, match="no answer to playbackInfo"):
            await session.info()
        await session.stop()


async def test_answers_are_matched_by_message_id() -> None:
    async with FakeTV(answers={}) as tv:
        session, _ = await loaded(tv)
        pending = asyncio.create_task(session.info())
        await eventually(lambda: tv.command_types()[-1] == "playbackInfo")
        message_id = tv.commands[-1][0]["messageID"]
        tv.emit({"kind": "response", "messageID": 999, "info": {"playbackState": "paused"}})  # someone else's
        tv.emit({"kind": "response", "messageID": message_id, "info": {"playbackState": "playing"}})
        assert (await pending).state == "playing"
        await session.stop()


async def test_a_refused_command_is_an_error() -> None:
    async with FakeTV(refuse="command setRate") as tv:
        session = await started(tv)
        with pytest.raises(PlaybackError, match=r"refused setRate \(403\)"):
            await session.pause()
        await session.stop()


async def test_a_lost_connection_during_a_command_is_an_error() -> None:
    async with FakeTV(lose_connection_on="command setRate") as tv:
        session = await started(tv)
        with pytest.raises(PlaybackError, match="did not take setRate"):
            await session.pause()
        await session.stop()


async def test_state_changes_come_from_notifications_once_each() -> None:
    states: list[State] = []
    async with FakeTV() as tv:
        session = await started(tv, on_state=states.append)
        await session.load(URL, "streaming")
        item = tv.commands[0][0]["item"]
        tv.emit({"type": "playbackState", "name": "loading"})
        tv.emit({"type": "playbackState", "name": "playing", "item": item, "params": {"rate": 1}})
        tv.emit({"type": "playbackState", "name": "playing"})
        tv.emit({"type": "playbackState", "name": "paused"})
        tv.emit({"type": "playbackState", "name": "rewinding"})  # unknown: ignored
        tv.emit({"type": "notification", "name": "itemPlayedToEnd", "item": item})
        assert states == ["loading", "playing", "paused", "ended"]
        assert session.state == "ended"
        await session.stop()


async def test_the_end_of_another_item_is_not_our_end() -> None:
    async with FakeTV() as tv:
        session, _ = await loaded(tv)
        tv.emit({"type": "notification", "name": "itemPlayedToEnd", "item": {"uuid": "SOMEONE-ELSES"}})
        assert session.state is None
        await session.stop()


async def test_the_item_is_taken_once_the_receiver_names_it() -> None:
    async with FakeTV() as tv:
        session, item = await loaded(tv)
        tv.emit({"type": "notification", "name": "seekableTimeRangesChanged", "item": {"uuid": "OTHER"}})
        assert not session.taken.is_set()
        tv.emit({"type": "notification", "name": "currentItemChanged", "itemCurrent": {"uuid": item}})
        assert session.taken.is_set()
        await session.stop()


async def test_the_receiver_closing_the_event_channel_ends_the_session_and_pending_requests() -> None:
    async with FakeTV(answers={}) as tv:
        session, _ = await loaded(tv)
        pending = asyncio.create_task(session.info())
        await eventually(lambda: tv.command_types()[-1] == "playbackInfo")
        tv.close_events()
        assert session.ended.is_set()
        with pytest.raises(PlaybackError, match="session ended"):
            await pending
        with pytest.raises(PlaybackError, match="not running"):
            await session.pause()
        await session.stop()


async def test_stop_stops_playback_then_tears_down_stream_and_session() -> None:
    async with FakeTV(answer_teardown=True) as tv:
        session, _ = await loaded(tv)
        await session.stop()
        assert tv.log[-3:] == ["command stop", "stream TEARDOWN", "TEARDOWN"]
        assert tv.requests[-2][2] == {"streams": [{"type": 130}]}
        assert tv.closed and session.ended.is_set()


async def test_stop_does_not_wait_for_a_receiver_that_ignores_the_session_teardown() -> None:
    async with FakeTV() as tv:
        session, _ = await loaded(tv)
        await asyncio.wait_for(session.stop(), 1)
        assert tv.closed


async def test_stop_is_idempotent_and_skips_commands_after_the_receiver_left() -> None:
    async with FakeTV(answer_teardown=True) as tv:
        session, _ = await loaded(tv)
        tv.close_events()
        await session.stop()
        await session.stop()
        assert "command stop" not in tv.log
        assert tv.log.count("TEARDOWN") == 1


def test_cmtime_is_milliseconds() -> None:
    assert cmtime(12.5) == ms(12500)
    assert cmtime(0.0004) == ms(0)


@pytest.mark.parametrize(
    ("value", "expected"),
    [
        (ms(1500), 1.5),
        ({"value": 90, "timescale": 30, "flags": 1, "epoch": 0}, 3.0),
        ({"value": 0, "timescale": 0, "flags": 1, "epoch": 0}, None),  # no timescale
        ({"value": 5, "timescale": 1000, "flags": 0, "epoch": 0}, None),  # not valid
        ({"value": 0, "timescale": 1000, "flags": 17, "epoch": 0}, None),  # indefinite (live)
        ({"value": 0, "timescale": 1000, "flags": 5, "epoch": 0}, None),  # +infinity
        ({"value": "1", "timescale": 1000, "flags": 1}, None),
        ({"value": True, "timescale": 1000, "flags": 1}, None),
        ("1500", None),
        (None, None),
    ],
)
def test_seconds_reads_only_valid_finite_cmtimes(value: object, expected: float | None) -> None:
    assert seconds(value) == expected


def test_buffered_ahead_uses_the_range_holding_the_position() -> None:
    ranges = [{"start": ms(0), "duration": ms(24000)}, {"start": ms(60000), "duration": ms(30000)}]
    assert buffered_ahead(ranges, 10) == 14
    assert buffered_ahead(ranges, 70) == 20
    assert buffered_ahead(ranges, 40) == 0
    assert buffered_ahead(ranges, None) is None
    assert buffered_ahead("ranges", 10) is None
    assert buffered_ahead([{"start": "x"}, 5], 10) == 0


async def test_an_error_about_the_item_fails_it() -> None:
    states: list[State] = []
    async with FakeTV() as tv:
        session = await started(tv, on_state=states.append)
        await session.load(URL, "file")
        item = tv.commands[0][0]["item"]
        assert isinstance(item, dict)
        tv.emit({"type": "error", "uuid": "SOMEONE-ELSES", "error": {"code": -12927}})
        assert states == []
        tv.emit({"type": "error", "uuid": item["uuid"], "error": {"code": -12927}, "playbackState": "loading"})
        assert states == ["failed"]
        await session.stop()


async def test_the_samsungs_stopped_after_the_end_is_ended_too() -> None:
    states: list[State] = []
    async with FakeTV() as tv:
        session = await started(tv, on_state=states.append)
        await session.load(URL, "file")
        tv.emit({"type": "playbackState", "name": "stopped", "reason": "ended"})
        tv.emit({"type": "playbackState", "name": "stopped"})  # without the reason: not the end
        assert states == ["ended"]
        await session.stop()


async def test_replay_plays_the_finished_item_then_seeks_once_it_plays() -> None:
    async with FakeTV(answers={"seek": {"position": ms(12000)}}) as tv:
        session = await started(tv)
        with pytest.raises(PlaybackError, match="nothing loaded"):
            await session.replay()
        await session.load(URL, "file", position=30)
        item = tv.commands[0][0]["item"]
        tv.emit({"type": "notification", "name": "itemPlayedToEnd", "item": item})
        replaying = asyncio.create_task(session.replay(12))
        await eventually(lambda: tv.command_types().count("setRate") == 2)  # load's, then replay's
        assert tv.commands[-1][0] == {"type": "setRate", "rate": 1.0}
        assert "seek" not in tv.command_types()  # not before it plays again
        tv.emit({"type": "playbackState", "name": "playing", "item": item})
        await replaying
        assert tv.commands[-1][0]["type"] == "seek" and tv.commands[-1][0]["time"] == ms(12000)
        assert tv.command_types().count("insertPlayQueueItem") == 1  # the Samsung ignores a second one
        await session.stop()


async def test_replay_gives_up_when_the_receiver_doesnt_play_again() -> None:
    async with FakeTV() as tv:
        session = PlaybackSession(tv, timings=Timings(reply=0.2, teardown=0.1, replay=0.05))
        await session.start()
        await session.load(URL, "file")
        with pytest.raises(PlaybackError, match="did not play the item again"):
            await session.replay()
        await session.stop()
