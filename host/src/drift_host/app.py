"""The dispatch loop: framed messages in; requests answered by tasks, media handled inline in arrival order."""

import asyncio
import logging
import time
from typing import BinaryIO, cast

from drift_host import __version__, messaging
from drift_host.airplay import Receivers
from drift_host.mirroring import Mirroring
from drift_host.playback import MediaType
from drift_host.protocol import MESSAGES, VERSION, ErrorCode, ProtocolError, error, parse
from drift_host.streaming import Action, Streaming

log = logging.getLogger(__name__)

_REQUESTS = {name for name, (kind, _) in MESSAGES.items() if kind == "request"}
_NOTIFICATIONS = {name for name, (kind, _) in MESSAGES.items() if kind == "notification"}
PAIRING_TIMEOUT = 180.0  # seconds between pair_begin and pair_pin
_UNTAGGED_ERROR_INTERVAL = 1.0  # at most one id-less error per code per second (media arrives at frame rate)


class _Pairing:
    def __init__(self) -> None:
        self.pin: asyncio.Future[str] = asyncio.get_running_loop().create_future()
        self.asked = asyncio.Event()  # set once the receiver shows its PIN
        self.task: asyncio.Task[None] | None = None

    async def read_pin(self) -> str:
        self.asked.set()
        return await asyncio.wait_for(self.pin, PAIRING_TIMEOUT)


class Host:
    def __init__(self, receivers: Receivers, writer: messaging.Writer) -> None:
        self._receivers = receivers
        self._writer = writer
        # One session at a time, either kind: starting one ends the other.
        self._mirroring = Mirroring(receivers, self._event)
        self._streaming = Streaming(receivers, self._event)
        self._pairings: dict[str, _Pairing] = {}
        self._tasks: set[asyncio.Task[None]] = set()
        self._untagged_errors: dict[str, float] = {}

    def receive(self, payload: bytes) -> asyncio.Task[None] | None:
        """Handle one frame: media inline (keeps its order), requests as tasks. Never raises."""
        request_id: object = None
        try:
            raw = messaging.decode(payload)
            if isinstance(raw, dict):
                request_id = cast(dict[str, object], raw).get("id")
            message = parse(raw)
            if message["type"] in _NOTIFICATIONS:
                self._mirroring.media(message)
                return None
            if message["type"] not in _REQUESTS or "host" in message:
                raise ProtocolError("unknown_type")  # a response or event sent our way
        except ProtocolError as e:
            self._refuse(e.code, request_id)
            return None
        except Exception:
            log.exception("message failed")
            self._refuse("internal_error", request_id)
            return None
        task = asyncio.create_task(self._answer(message))
        self._tasks.add(task)
        task.add_done_callback(self._tasks.discard)
        return task

    async def handle(self, payload: bytes) -> None:
        """receive() and wait for the answer (for tests and one-off use)."""
        task = self.receive(payload)
        if task is not None:
            await task

    async def close(self) -> None:
        if self._tasks:
            await asyncio.gather(*self._tasks, return_exceptions=True)
        for pairing in self._pairings.values():
            if pairing.task is not None:
                pairing.task.cancel()
        await self._mirroring.close()
        await self._streaming.close()

    async def _answer(self, request: dict[str, object]) -> None:
        try:
            response = await self._dispatch(request)
            self._writer.send({"v": VERSION, "id": request["id"], **response})
        except ProtocolError as e:
            self._refuse(e.code, request["id"])
        except Exception:
            log.exception("request failed")
            self._refuse("internal_error", request["id"])

    async def _dispatch(self, request: dict[str, object]) -> dict[str, object]:
        match request["type"]:
            case "hello":
                return {"type": "hello", "host": __version__}
            case "scan":
                timeout_ms = cast(int, request.get("timeout_ms", 3000))
                devices = await self._receivers.scan(timeout_ms / 1000)
                return {"type": "devices", "devices": [d.to_message() for d in devices]}
            case "pair_begin":
                await self._pair_begin(cast(str, request["device"]))
            case "pair_pin":
                await self._pair_pin(cast(str, request["device"]), cast(str, request["pin"]))
            case "mirror_start":
                await self._streaming.close()
                session = await self._mirroring.start(cast(str, request["device"]), audio="audio" in request)
                return {"type": "mirror_started", "session": session}
            case "mirror_stop":
                await self._mirroring.stop(cast(str, request["session"]))
            case "stream_start":
                await self._mirroring.close()
                session = await self._streaming.start(
                    cast(str, request["device"]),
                    cast(str, request["url"]),
                    cast(MediaType, request["media_type"]),
                    cast(float | None, request.get("position")),
                )
                return {"type": "stream_started", "session": session}
            case "stream_control":
                await self._streaming.control(
                    cast(str, request["session"]),
                    cast(Action, request["action"]),
                    cast(float | None, request.get("position")),
                )
            case "stream_stop":
                await self._streaming.stop(cast(str, request["session"]))
            case _:
                raise ProtocolError("unknown_type")  # in the protocol, not handled by this host
        return {"type": "ok"}

    async def _pair_begin(self, device: str) -> None:
        """Answer once the receiver shows its PIN (or pairing fails before that)."""
        previous = self._pairings.pop(device, None)
        if previous is not None and previous.task is not None:
            previous.task.cancel()
        pairing = _Pairing()
        pairing.task = asyncio.create_task(self._receivers.pair(device, pairing.read_pin))
        self._pairings[device] = pairing
        asked = asyncio.create_task(pairing.asked.wait())
        await asyncio.wait({asked, pairing.task}, return_when=asyncio.FIRST_COMPLETED)
        asked.cancel()
        if pairing.task.done() and not pairing.asked.is_set():
            self._pairings.pop(device, None)
            pairing.task.result()  # raises the receiver's refusal

    async def _pair_pin(self, device: str, pin: str) -> None:
        pairing = self._pairings.pop(device, None)
        if pairing is None or pairing.task is None or not pairing.asked.is_set():
            raise ProtocolError("pairing_failed")  # no pairing waiting for a PIN
        pairing.pin.set_result(pin)
        try:
            await pairing.task
        except TimeoutError as e:
            raise ProtocolError("pairing_failed") from e

    def _event(self, event: dict[str, object]) -> None:
        self._writer.send({"v": VERSION, **event})

    def _refuse(self, code: ErrorCode, request_id: object) -> None:
        log.info("refused: %s", code)
        if not isinstance(request_id, str):
            # No id to answer (e.g. media): don't flood the extension at frame rate.
            now = time.monotonic()
            if now - self._untagged_errors.get(code, -_UNTAGGED_ERROR_INTERVAL) < _UNTAGGED_ERROR_INTERVAL:
                return
            self._untagged_errors[code] = now
        self._writer.send(error(code, request_id))


async def serve(receivers: Receivers, stdin: BinaryIO, stdout: BinaryIO) -> None:
    """Run until the browser closes the pipe."""
    writer = messaging.Writer(stdout)
    host = Host(receivers, writer)
    try:
        while True:
            try:
                payload = await asyncio.to_thread(messaging.read_frame, stdin)
            except ProtocolError as e:
                # The frame wasn't consumed, so the stream can't be resynchronised: report and end the session.
                writer.send(error(e.code))
                break
            if payload is None:
                break
            host.receive(payload)
    except EOFError:
        log.warning("browser closed the pipe mid-message")
    finally:
        await host.close()
        await receivers.close()
