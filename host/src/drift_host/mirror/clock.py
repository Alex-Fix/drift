"""NTP-format timestamps on the wall clock pyatv's timing server reports to the receiver."""

import time

_NTP_EPOCH_OFFSET = 2_208_988_800  # seconds from 1900-01-01 to 1970-01-01


def ntp_from_ns(unix_ns: int) -> int:
    """Unix time in nanoseconds → 64-bit NTP (seconds << 32 | fraction)."""
    seconds, ns = divmod(unix_ns, 1_000_000_000)
    return (seconds + _NTP_EPOCH_OFFSET) << 32 | (ns << 32) // 1_000_000_000


def ntp_now() -> int:
    return ntp_from_ns(time.time_ns())


def ntp_after(start: int, seconds: float) -> int:
    return start + round(seconds * (1 << 32))
