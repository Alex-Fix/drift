"""Retrying a receiver that is unreachable for a while, for both kinds of session.

The Samsung refuses a new session for ~10-17 s after the previous one (it never answers the session TEARDOWN), so an
unreachable receiver is retried for a while; the extension waits RETRY_FOR + margin for mirror_start / stream_start.
"""

import asyncio
import itertools
import logging
from collections.abc import Awaitable, Callable

from drift_host.protocol import ProtocolError

log = logging.getLogger(__name__)

RETRY_FOR = 30.0
RETRY_DELAYS = (2.0, 3.0, 4.0, 5.0)  # then 5 s each


async def while_unreachable[T](connect: Callable[[], Awaitable[T]]) -> T:
    """`connect()`, again after a pause each time it raises `device_unreachable`, for up to RETRY_FOR seconds."""
    loop = asyncio.get_running_loop()
    deadline = loop.time() + RETRY_FOR
    for attempt in itertools.count():
        try:
            return await connect()
        except ProtocolError as e:
            delay = RETRY_DELAYS[min(attempt, len(RETRY_DELAYS) - 1)]
            if e.code != "device_unreachable" or loop.time() + delay > deadline:
                raise
            log.info("receiver unreachable; retrying in %.0f s", delay)
            await asyncio.sleep(delay)
    raise AssertionError("unreachable")
