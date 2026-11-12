"""The dispatch loop: framed messages in, one task per request, responses and events out."""

import asyncio
import logging
from typing import BinaryIO, cast

from drift_host import __version__, messaging
from drift_host.airplay import Action, Receivers
from drift_host.protocol import VERSION, ProtocolError, error, parse

log = logging.getLogger(__name__)


class Host:
    def __init__(self, receivers: Receivers, writer: messaging.Writer) -> None:
        self._receivers = receivers
        self._writer = writer

    async def handle(self, payload: bytes) -> None:
        """Answer one request. Never raises: every failure becomes an `error` message with a constant code."""
        request_id: object = None
        try:
            raw = messaging.decode(payload)
            if isinstance(raw, dict):
                request_id = cast(dict[str, object], raw).get("id")
            request = parse(raw)
            if request["type"] not in ("hello", "scan", "play", "control", "stop") or "host" in request:
                raise ProtocolError("unknown_type")  # a response or event sent our way
            response = await self._dispatch(request)
            self._writer.send({"v": VERSION, "id": request["id"], **response})
        except ProtocolError as e:
            log.info("request refused: %s", e.code)
            self._writer.send(error(e.code, request_id))
        except Exception:
            log.exception("request failed")
            self._writer.send(error("internal_error", request_id))

    async def _dispatch(self, request: dict[str, object]) -> dict[str, object]:
        match request["type"]:
            case "hello":
                return {"type": "hello", "host": __version__}
            case "scan":
                timeout_ms = cast(int, request.get("timeout_ms", 3000))
                devices = await self._receivers.scan(timeout_ms / 1000)
                return {"type": "devices", "devices": [d.to_message() for d in devices]}
            case "play":
                await self._receivers.play(
                    cast(str, request["device"]), cast(str, request["url"]), cast(float | None, request.get("position"))
                )
            case "control":
                await self._receivers.control(
                    cast(str, request["device"]),
                    cast(Action, request["action"]),
                    cast(float | None, request.get("position")),
                )
            case "stop":
                await self._receivers.stop(cast(str, request["device"]))
        return {"type": "ok"}


async def serve(receivers: Receivers, stdin: BinaryIO, stdout: BinaryIO) -> None:
    """Run until the browser closes the pipe."""
    writer = messaging.Writer(stdout)
    host = Host(receivers, writer)
    tasks: set[asyncio.Task[None]] = set()
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
            task = asyncio.create_task(host.handle(payload))
            tasks.add(task)
            task.add_done_callback(tasks.discard)
    except EOFError:
        log.warning("browser closed the pipe mid-message")
    finally:
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)
        await receivers.close()
