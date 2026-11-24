import asyncio
import base64
import io
import json
import struct

import pytest

from drift_host import messaging
from drift_host.app import Host
from drift_host.mirror import packets
from tests.fake_tv import FakeTV, eventually
from tests.test_app import FakeReceivers, frames

AVCC = base64.b64encode(bytes.fromhex("01640028ffe1000167010001 68".replace(" ", ""))).decode()
CONFIG = {"codec": "h264", "record": AVCC, "width": 1920, "height": 1080}
AUDIO = {"format": "pcm_s16", "rate": 44100, "channels": 2}


class Harness:
    def __init__(self, tv: FakeTV) -> None:
        self.receivers = FakeReceivers()
        self.receivers.tv = tv
        self.stdout = io.BytesIO()
        self.host = Host(self.receivers, messaging.Writer(self.stdout))

    def messages(self) -> list[dict[str, object]]:
        return [m for m in frames(self.stdout.getvalue()) if isinstance(m, dict)]

    def of_type(self, kind: str) -> list[dict[str, object]]:
        return [m for m in self.messages() if m["type"] == kind]

    async def ask(self, request: dict[str, object]) -> dict[str, object]:
        await self.host.handle(json.dumps({"v": 1, **request}).encode())
        return [m for m in self.messages() if m.get("id") == request["id"]][-1]

    def send(self, notification: dict[str, object]) -> None:
        self.host.receive(json.dumps({"v": 1, **notification}).encode())

    async def start(self, audio: bool = False) -> str:
        request: dict[str, object] = {"type": "mirror_start", "id": "m", "device": "AA:BB"}
        if audio:
            request["audio"] = AUDIO
        reply = await self.ask(request)
        assert reply["type"] == "mirror_started", reply
        session = reply["session"]
        assert isinstance(session, str)
        return session


def video(
    session: str, ts: int, key: bool, payload: bytes, config: dict[str, object] | None = None
) -> dict[str, object]:
    message: dict[str, object] = {
        "type": "video",
        "session": session,
        "ts": ts,
        "key": key,
        "data": base64.b64encode(payload).decode(),
    }
    if config:
        message["config"] = config
    return message


async def test_start_media_and_stop_reach_the_receiver_in_order() -> None:
    async with FakeTV(answer_teardown=True) as tv:
        h = Harness(tv)
        session = await h.start()
        assert h.of_type("mirror_status")[0]["state"] == "mirroring"
        h.send(video(session, 0, True, b"\x00\x00\x00\x02\x65\x01", CONFIG))
        for n in range(1, 20):
            h.send(video(session, n * 16_667, False, b"\x00\x00\x00\x02\x41" + bytes([n])))
        # codec packet + 20 sealed frames (heartbeats may interleave)
        await eventually(lambda: sum(1 for _ in _packets(tv) if _[0] == packets.TYPE_VIDEO) == 20)
        kinds = [k for k, _ in _packets(tv) if k != packets.TYPE_HEARTBEAT]
        assert kinds[:2] == [packets.TYPE_CODEC, packets.TYPE_VIDEO]
        frame_sizes = [size for k, size in _packets(tv) if k == packets.TYPE_VIDEO]
        assert frame_sizes == [6 + packets.TAG_SIZE] + [6 + packets.TAG_SIZE] * 19
        assert (await h.ask({"type": "mirror_stop", "id": "s", "session": session}))["type"] == "ok"
        stopped = h.of_type("mirror_status")[-1]
        assert stopped["state"] == "stopped" and "reason" not in stopped
        assert stopped["codec"] == "h264" and stopped["width"] == 1920
        assert "TEARDOWN" in tv.log
        await h.host.close()


async def test_audio_notifications_become_rtp_packets() -> None:
    async with FakeTV(answer_teardown=True) as tv:
        h = Harness(tv)
        session = await h.start(audio=True)
        pcm = base64.b64encode(bytes(352 * 4 * 3)).decode()
        h.send({"type": "audio", "session": session, "ts": 0, "data": pcm})
        await eventually(lambda: len(tv.audio_packets) == 3)
        await h.host.close()


async def test_video_before_its_decoder_setup_is_dropped_until_a_configured_keyframe() -> None:
    async with FakeTV(answer_teardown=True) as tv:
        h = Harness(tv)
        session = await h.start()
        h.send(video(session, 0, True, b"\x00\x00\x00\x01\x65"))  # no config yet
        h.send(video(session, 1, False, b"\x00\x00\x00\x01\x41"))
        h.send(video(session, 2, True, b"\x00\x00\x00\x01\x65", CONFIG))
        await eventually(lambda: any(k == packets.TYPE_VIDEO for k, _ in _packets(tv)))
        await asyncio.sleep(0.05)
        assert sum(1 for k, _ in _packets(tv) if k == packets.TYPE_VIDEO) == 1
        await h.ask({"type": "mirror_stop", "id": "s", "session": session})
        assert h.of_type("mirror_status")[-1]["dropped"] == 2
        await h.host.close()


async def test_media_for_an_unknown_session_gets_one_untagged_error() -> None:
    async with FakeTV(answer_teardown=True) as tv:
        h = Harness(tv)
        await h.start()
        for n in range(30):
            h.send(video("f" * 32, n, True, b"\x00\x00\x00\x01\x65", CONFIG))
        errors = h.of_type("error")
        assert errors == [{"v": 1, "type": "error", "code": "session_unknown"}]
        await h.host.close()


async def test_starting_again_replaces_the_running_session() -> None:
    async with FakeTV(answer_teardown=True) as tv:
        h = Harness(tv)
        first = await h.start()
        second = await h.start()
        assert first != second
        statuses = [(m["session"], m["state"]) for m in h.of_type("mirror_status")]
        assert statuses == [(first, "mirroring"), (first, "stopped"), (second, "mirroring")]
        reply = await h.ask({"type": "mirror_stop", "id": "s", "session": first})
        assert reply == {"v": 1, "type": "error", "id": "s", "code": "session_unknown"}
        await h.host.close()


async def test_receiver_ending_the_session_is_reported() -> None:
    async with FakeTV(answer_teardown=True) as tv:
        h = Harness(tv)
        session = await h.start()
        tv.drop_data_connection()
        await eventually(lambda: h.of_type("mirror_status")[-1]["state"] == "stopped")
        last = h.of_type("mirror_status")[-1]
        assert (last["session"], last["state"], last["reason"]) == (session, "stopped", "mirror_failed")
        await h.host.close()


async def test_refused_mirroring_is_mirror_failed() -> None:
    async with FakeTV(refuse="stream SETUP") as tv:
        h = Harness(tv)
        reply = await h.ask({"type": "mirror_start", "id": "m", "device": "AA:BB"})
        assert reply == {"v": 1, "type": "error", "id": "m", "code": "mirror_failed"}
        await h.host.close()


async def test_full_queue_drops_video_until_the_next_keyframe(monkeypatch: pytest.MonkeyPatch) -> None:
    from drift_host import mirroring

    monkeypatch.setattr(mirroring, "QUEUE_SIZE", 2)
    async with FakeTV(answer_teardown=True) as tv:
        h = Harness(tv)
        session = await h.start()
        # sent synchronously, so the pump can't drain in between: 2 fit, the 3rd is dropped, deltas after it too
        h.send(video(session, 0, True, b"\x00\x00\x00\x01\x65", CONFIG))
        h.send(video(session, 1, False, b"\x00\x00\x00\x01\x41"))
        h.send(video(session, 2, False, b"\x00\x00\x00\x01\x41"))
        h.send(video(session, 3, False, b"\x00\x00\x00\x01\x41"))
        await asyncio.sleep(0.05)
        h.send(video(session, 4, True, b"\x00\x00\x00\x01\x65", CONFIG))
        await eventually(lambda: sum(1 for k, _ in _packets(tv) if k == packets.TYPE_VIDEO) == 3)
        await h.ask({"type": "mirror_stop", "id": "s", "session": session})
        assert h.of_type("mirror_status")[-1]["dropped"] == 2
        await h.host.close()


async def test_pairing_answers_begin_when_the_pin_shows_then_checks_the_pin() -> None:
    async with FakeTV() as tv:
        h = Harness(tv)
        assert (await h.ask({"type": "pair_begin", "id": "p1", "device": "AA:BB"}))["type"] == "ok"
        assert (await h.ask({"type": "pair_pin", "id": "p2", "device": "AA:BB", "pin": "4321"}))["type"] == "ok"
        assert ("paired", "AA:BB") in h.receivers.calls


async def test_wrong_pin_is_pairing_failed_and_pin_without_begin_too() -> None:
    async with FakeTV() as tv:
        h = Harness(tv)
        await h.ask({"type": "pair_begin", "id": "p1", "device": "AA:BB"})
        reply = await h.ask({"type": "pair_pin", "id": "p2", "device": "AA:BB", "pin": "0000"})
        assert reply == {"v": 1, "type": "error", "id": "p2", "code": "pairing_failed"}
        reply = await h.ask({"type": "pair_pin", "id": "p3", "device": "AA:BB", "pin": "4321"})
        assert reply == {"v": 1, "type": "error", "id": "p3", "code": "pairing_failed"}


def _packets(tv: FakeTV) -> list[tuple[int, int]]:
    """(type, payload size) of each packet the receiver got on the data connection."""
    out, data, at = [], bytes(tv.received), 0
    while at + packets.HEADER_SIZE <= len(data):
        size, kind = struct.unpack_from("<IB", data, at)
        out.append((kind, size))
        at += packets.HEADER_SIZE + size
    return out


async def test_an_unreachable_receiver_is_retried_until_it_accepts(monkeypatch: pytest.MonkeyPatch) -> None:
    from drift_host import retry
    from drift_host.protocol import ProtocolError

    monkeypatch.setattr(retry, "RETRY_DELAYS", (0.01,))
    async with FakeTV(answer_teardown=True) as tv:
        h = Harness(tv)
        refusals = iter([True, True, False])
        open_mirror = h.receivers.open_mirror

        async def flaky(device: str):  # type: ignore[no-untyped-def]
            if next(refusals):
                raise ProtocolError("device_unreachable")
            return await open_mirror(device)

        monkeypatch.setattr(h.receivers, "open_mirror", flaky)
        await h.start()
        await h.host.close()


async def test_retrying_gives_up_after_the_retry_window(monkeypatch: pytest.MonkeyPatch) -> None:
    from drift_host import retry
    from drift_host.protocol import ProtocolError

    monkeypatch.setattr(retry, "RETRY_DELAYS", (0.05,))
    monkeypatch.setattr(retry, "RETRY_FOR", 0.2)
    async with FakeTV() as tv:
        h = Harness(tv)

        async def unreachable(device: str):  # type: ignore[no-untyped-def]
            raise ProtocolError("device_unreachable")

        monkeypatch.setattr(h.receivers, "open_mirror", unreachable)
        reply = await h.ask({"type": "mirror_start", "id": "m", "device": "AA:BB"})
        assert reply == {"v": 1, "type": "error", "id": "m", "code": "device_unreachable"}
        await h.host.close()


async def test_a_refusal_is_not_retried() -> None:
    async with FakeTV(refuse="session SETUP") as tv:
        h = Harness(tv)
        reply = await h.ask({"type": "mirror_start", "id": "m", "device": "AA:BB"})
        assert reply["code"] == "mirror_failed"
        assert tv.log.count("session SETUP") == 1


async def test_dropping_frames_is_reported_while_it_happens(monkeypatch: pytest.MonkeyPatch) -> None:
    from drift_host import mirroring

    monkeypatch.setattr(mirroring, "QUEUE_SIZE", 1)
    async with FakeTV(answer_teardown=True) as tv:
        h = Harness(tv)
        session = await h.start()
        before = len(h.of_type("mirror_status"))
        for n in range(5):  # synchronously: the queue holds one, the rest drop
            h.send(video(session, n, True, b"\x00\x00\x00\x01\x65", CONFIG))
        reports = h.of_type("mirror_status")[before:]
        assert len(reports) == 1  # rate-limited
        assert reports[0]["state"] == "mirroring" and reports[0]["dropped"] == 1
        await h.host.close()


async def test_stats_are_logged_periodically(monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture) -> None:
    import logging

    from drift_host import mirroring

    monkeypatch.setattr(mirroring, "STATS_INTERVAL", 0.05)
    caplog.set_level(logging.INFO, logger="drift_host.mirroring")
    async with FakeTV(answer_teardown=True) as tv:
        h = Harness(tv)
        session = await h.start()
        h.send(video(session, 0, True, b"\x00\x00\x00\x02\x65\x01", CONFIG))
        await eventually(lambda: any("fps" in r.message for r in caplog.records))
        line = next(r.message for r in caplog.records if "fps" in r.message)
        assert "h264 1920x1080" in line and "dropped" in line
        await h.host.close()
