import contextlib
import plistlib
from collections.abc import Mapping
from typing import cast

import pytest
from pyatv import exceptions
from pyatv.support.http import HttpConnection
from pyatv.support.rtsp import RtspSession

from drift_host.mirror.pyatv_control import MAX_EVENT_BODY, PyatvControl, decode_event


class RaisingRtsp:
    def __init__(self, error: Exception) -> None:
        self.error = error

    async def exchange(self, *_: object, **__: object) -> object:
        raise self.error


def control(error: Exception) -> PyatvControl:
    return PyatvControl(
        cast(HttpConnection, None),
        cast(RtspSession, RaisingRtsp(error)),
        cast("object", None),  # type: ignore[arg-type]
        0,
        contextlib.AsyncExitStack(),
    )


@pytest.mark.parametrize("error", [exceptions.ConnectionLostError("lost"), exceptions.ConnectionFailedError("x")])
async def test_pyatv_connection_errors_become_connection_errors(error: Exception) -> None:
    with pytest.raises(ConnectionError):
        await control(error).request("TEARDOWN")


async def test_pyatv_timeouts_become_timeouts() -> None:
    with pytest.raises(TimeoutError):
        await control(exceptions.OperationTimeoutError("slow")).request("TEARDOWN")


def bplist(value: Mapping[str, object] | list[object]) -> bytes:
    return plistlib.dumps(value, fmt=plistlib.FMT_BINARY)


def test_event_messages_are_decoded_plain_or_wrapped_like_commands() -> None:
    message = {"type": "playbackState", "name": "paused"}
    assert decode_event(bplist(message)) == message
    assert decode_event(bplist({"params": {"data": bplist(message)}})) == message


def test_a_message_whose_params_are_its_own_is_not_unwrapped() -> None:
    message = {"type": "playbackState", "name": "playing", "params": {"rate": 1}}
    assert decode_event(bplist(message)) == message


@pytest.mark.parametrize(
    "body",
    [
        b"",
        b"not a plist",
        b"bplist00garbage",
        bplist(["a list"]),
        bplist({"params": {"data": b"bplist00garbage"}}),
        bplist({"padding": b"x" * MAX_EVENT_BODY}),
    ],
)
def test_anything_else_on_the_event_channel_is_ignored(body: bytes) -> None:
    assert decode_event(body) is None
