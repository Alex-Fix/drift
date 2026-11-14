import asyncio

import pytest

from drift_host import retry, streaming
from drift_host.protocol import ProtocolError
from tests.fake_tv import FakeTV, eventually
from tests.test_app_mirroring import Harness

URL = "https://media.example/movie.m3u8"


def ms(value: int) -> dict[str, object]:
    return {"value": value, "timescale": 1000, "flags": 1, "epoch": 0}


async def start(h: Harness, **fields: object) -> str:
    reply = await h.ask(
        {"type": "stream_start", "id": "s", "device": "AA:BB", "url": URL, "media_type": "streaming", **fields}
    )
    assert reply["type"] == "stream_started", reply
    session = reply["session"]
    assert isinstance(session, str)
    return session


def statuses(h: Harness) -> list[tuple[object, ...]]:
    return [(m["session"], m["state"]) for m in h.of_type("stream_status")]


def item(tv: FakeTV) -> dict[str, object]:
    payload = next(p for p, _, _ in tv.commands if p["type"] == "insertPlayQueueItem")
    value = payload["item"]
    assert isinstance(value, dict)
    return value


async def test_stream_start_loads_the_url_on_the_receiver_and_reports_loading() -> None:
    async with FakeTV(answer_teardown=True) as tv:
        h = Harness(tv)
        session = await start(h, position=30)
        assert tv.log[:4] == ["session SETUP", "events opened", "RECORD", "playback SETUP"]
        assert item(tv)["Content-Location"] == URL
        assert item(tv)["mediaType"] == "streaming"
        assert item(tv)["Start-Position"] == ms(30000)
        assert statuses(h) == [(session, "loading")]
        await h.host.close()


async def test_state_changes_from_the_receiver_are_reported_at_once() -> None:
    async with FakeTV(answer_teardown=True) as tv:
        h = Harness(tv)
        session = await start(h)
        tv.emit({"type": "playbackState", "name": "playing", "item": {"uuid": item(tv)["uuid"]}})
        tv.emit({"type": "playbackState", "name": "paused"})
        assert statuses(h) == [(session, "loading"), (session, "playing"), (session, "paused")]
        await h.host.close()


async def test_position_duration_and_buffer_are_polled(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(streaming, "POLL_INTERVAL", 0.01)
    info = {
        "playbackState": "playing",
        "rate": 1,
        "position": ms(61250),
        "duration": ms(5400000),
        "loadedTimeRanges": [{"start": ms(60000), "duration": ms(25250)}],
    }
    async with FakeTV(answer_teardown=True, answers={"playbackInfo": {"info": info}}) as tv:
        h = Harness(tv)
        session = await start(h)
        await eventually(lambda: len(h.of_type("stream_status")) >= 2)
        assert h.of_type("stream_status")[1] == {
            "v": 1,
            "type": "stream_status",
            "session": session,
            "state": "playing",
            "position": 61.25,
            "duration": 5400.0,
            "buffered": 24.0,
        }
        await h.host.close()


async def test_a_live_stream_has_no_duration(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(streaming, "POLL_INTERVAL", 0.01)
    indefinite = {"value": 0, "timescale": 1000, "flags": 17, "epoch": 0}
    info = {"playbackState": "playing", "position": ms(5000), "duration": indefinite}
    async with FakeTV(answer_teardown=True, answers={"playbackInfo": {"info": info}}) as tv:
        h = Harness(tv)
        await start(h)
        await eventually(lambda: len(h.of_type("stream_status")) >= 2)
        status = h.of_type("stream_status")[1]
        assert status["position"] == 5.0 and "duration" not in status
        await h.host.close()


async def test_the_end_of_the_video_is_ended_with_the_session_still_open() -> None:
    async with FakeTV(answer_teardown=True) as tv:
        h = Harness(tv)
        session = await start(h)
        tv.emit({"type": "notification", "name": "itemPlayedToEnd", "item": {"uuid": item(tv)["uuid"]}})
        assert statuses(h)[-1] == (session, "ended")
        assert (await h.ask({"type": "stream_control", "id": "c", "session": session, "action": "pause"}))[
            "type"
        ] == "ok"
        await h.host.close()


async def test_stopping_at_the_end_counts_as_ended_without_the_notification(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(streaming, "POLL_INTERVAL", 0.01)
    info = {"playbackState": "paused", "position": ms(599500), "duration": ms(600000)}
    async with FakeTV(answer_teardown=True, answers={"playbackInfo": {"info": info}}) as tv:
        h = Harness(tv)
        session = await start(h)
        await eventually(lambda: statuses(h)[-1] == (session, "ended"))
        await h.host.close()


async def test_a_stream_not_playing_in_time_has_failed(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(streaming, "START_TIMEOUT", 0.05)
    async with FakeTV(answer_teardown=True) as tv:
        h = Harness(tv)
        session = await start(h)
        await eventually(lambda: statuses(h)[-1] == (session, "failed"))
        assert h.of_type("stream_status")[-1]["reason"] == "stream_failed"
        assert tv.closed and "command stop" in tv.log
        reply = await h.ask({"type": "stream_stop", "id": "x", "session": session})
        assert reply["code"] == "session_unknown"
        await h.host.close()


async def test_playing_in_time_cancels_the_deadline(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(streaming, "START_TIMEOUT", 0.05)
    async with FakeTV(answer_teardown=True) as tv:
        h = Harness(tv)
        session = await start(h)
        tv.emit({"type": "playbackState", "name": "playing"})
        tv.emit({"type": "playbackState", "name": "paused"})  # pausing later doesn't fail it
        await asyncio.sleep(0.1)
        assert statuses(h)[-1] == (session, "paused")
        await h.host.close()


async def test_the_receiver_leaving_stops_the_session() -> None:
    async with FakeTV(answer_teardown=True) as tv:
        h = Harness(tv)
        session = await start(h)
        tv.close_events()
        await eventually(lambda: statuses(h)[-1] == (session, "stopped"))
        assert h.of_type("stream_status")[-1]["reason"] == "stream_failed"
        await h.host.close()


async def test_controls_reach_the_receiver() -> None:
    async with FakeTV(answer_teardown=True, answers={"seek": {"position": ms(90000)}}) as tv:
        h = Harness(tv)
        session = await start(h)
        for action in ({"action": "pause"}, {"action": "resume"}, {"action": "seek", "position": 90}):
            reply = await h.ask({"type": "stream_control", "id": "c", "session": session, **action})
            assert reply["type"] == "ok"
        assert tv.command_types()[-3:] == ["setRate", "setRate", "seek"]
        assert tv.commands[-1][0]["time"] == ms(90000)
        await h.host.close()


async def test_a_refused_control_is_stream_failed() -> None:
    async with FakeTV(answer_teardown=True, refuse="command seek") as tv:
        h = Harness(tv)
        session = await start(h)
        reply = await h.ask({"type": "stream_control", "id": "c", "session": session, "action": "seek", "position": 9})
        assert reply == {"v": 1, "type": "error", "id": "c", "code": "stream_failed"}
        await h.host.close()


async def test_controls_for_another_session_are_session_unknown() -> None:
    async with FakeTV(answer_teardown=True) as tv:
        h = Harness(tv)
        await start(h)
        reply = await h.ask({"type": "stream_control", "id": "c", "session": "0" * 32, "action": "pause"})
        assert reply == {"v": 1, "type": "error", "id": "c", "code": "session_unknown"}
        await h.host.close()


async def test_stream_stop_stops_playback_and_reports_stopped() -> None:
    async with FakeTV(answer_teardown=True) as tv:
        h = Harness(tv)
        session = await start(h)
        assert (await h.ask({"type": "stream_stop", "id": "x", "session": session}))["type"] == "ok"
        assert statuses(h)[-1] == (session, "stopped")
        assert "reason" not in h.of_type("stream_status")[-1]
        assert tv.log[-3:] == ["command stop", "stream TEARDOWN", "TEARDOWN"] and tv.closed
        await h.host.close()


@pytest.mark.parametrize("step", ["playback SETUP", "command insertPlayQueueItem"])
async def test_a_receiver_refusing_the_stream_is_stream_failed(step: str) -> None:
    async with FakeTV(answer_teardown=True, refuse=step) as tv:
        h = Harness(tv)
        reply = await h.ask({"type": "stream_start", "id": "s", "device": "AA:BB", "url": URL, "media_type": "file"})
        assert reply == {"v": 1, "type": "error", "id": "s", "code": "stream_failed"}
        assert h.of_type("stream_status") == []
        assert tv.closed
        assert tv.log.count("session SETUP") == 1  # not retried
        await h.host.close()


async def test_an_unreachable_receiver_is_retried(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(retry, "RETRY_DELAYS", (0.01,))
    async with FakeTV(answer_teardown=True) as tv:
        h = Harness(tv)
        refusals = iter([True, False])
        open_playback = h.receivers.open_playback

        async def flaky(device: str):  # type: ignore[no-untyped-def]
            if next(refusals):
                raise ProtocolError("device_unreachable")
            return await open_playback(device)

        monkeypatch.setattr(h.receivers, "open_playback", flaky)
        await start(h)
        await h.host.close()


async def test_starting_again_replaces_the_running_stream() -> None:
    async with FakeTV(answer_teardown=True) as tv:
        h = Harness(tv)
        first = await start(h)
        second = await start(h)
        assert statuses(h) == [(first, "loading"), (first, "stopped"), (second, "loading")]
        await h.host.close()


async def test_a_stream_ends_mirroring_and_mirroring_ends_a_stream() -> None:
    async with FakeTV(answer_teardown=True) as tv:
        h = Harness(tv)
        mirror = await h.start()
        stream = await start(h)
        assert h.of_type("mirror_status")[-1]["session"] == mirror
        assert h.of_type("mirror_status")[-1]["state"] == "stopped"
        await h.start()
        assert statuses(h)[-1] == (stream, "stopped")
        await h.host.close()


async def test_closing_the_host_stops_the_stream() -> None:
    async with FakeTV(answer_teardown=True) as tv:
        h = Harness(tv)
        session = await start(h)
        await h.host.close()
        assert statuses(h)[-1] == (session, "stopped") and tv.closed
