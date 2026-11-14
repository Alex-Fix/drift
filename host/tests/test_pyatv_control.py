import contextlib
from typing import cast

import pytest
from pyatv import exceptions
from pyatv.support.http import HttpConnection
from pyatv.support.rtsp import RtspSession

from drift_host.mirror.pyatv_control import PyatvControl


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
