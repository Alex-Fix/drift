"""Protocol v1 message validation. Mirrors extension/src/protocol.ts; contract in docs/protocol.md.

Every message — request, response, event or notification — is checked against MESSAGES. Unknown fields are rejected,
never ignored.
"""

import re
from dataclasses import dataclass
from typing import Final, Literal, get_args
from urllib.parse import urlsplit

VERSION: Final = 1

type ErrorCode = Literal[
    "invalid_message",
    "unsupported_version",
    "unknown_type",
    "message_too_large",
    "unknown_device",
    "unsupported_url",
    "pairing_required",
    "device_unreachable",
    "internal_error",
    "mirror_unsupported",
    "mirror_failed",
    "session_unknown",
    "pairing_failed",
]


class ProtocolError(Exception):
    """A message the host refuses. The code goes back to the extension; nothing from the message is echoed."""

    def __init__(self, code: ErrorCode) -> None:
        super().__init__(code)
        self.code: ErrorCode = code


@dataclass(frozen=True)
class Str:
    max_len: int


@dataclass(frozen=True)
class Num:
    min: float
    max: float | None = None
    integer: bool = False


@dataclass(frozen=True)
class OneOf:
    values: frozenset[str]


@dataclass(frozen=True)
class Url:
    pass


@dataclass(frozen=True)
class Devices:
    max_items: int = 64


@dataclass(frozen=True)
class Pattern:
    regex: str  # must match the whole string


@dataclass(frozen=True)
class Bool:
    pass


@dataclass(frozen=True)
class Base64:
    max_bytes: int  # decoded size


@dataclass(frozen=True)
class Obj:
    fields: "dict[str, tuple[Spec, bool]]"


type Spec = Str | Num | OneOf | Url | Devices | Pattern | Bool | Base64 | Obj
# notification: extension → host, no id, no response (media at frame rate)
type Kind = Literal["request", "response", "event", "notification"]

ID = Str(64)
DEVICE = Str(128)
NAME = Str(256)
URL_MAX = 8 * 1024
POSITION = Num(0)
STATES = OneOf(frozenset({"idle", "loading", "playing", "paused"}))
ERROR_CODES = OneOf(frozenset(get_args(ErrorCode.__value__)))
SESSION = Pattern(r"[0-9a-f]{32}")
MEDIA_TS = Num(0, 2**53, integer=True)  # microseconds on the capture clock
DIMENSION = Num(16, 8192, integer=True)
VIDEO_CODECS = OneOf(frozenset({"h264", "hevc"}))
MAX_VIDEO_CHUNK = 2 * 1024 * 1024
MAX_AUDIO_CHUNK = 256 * 1024

# type → (kind, {field: (spec, required)})
MESSAGES: Final[dict[str, tuple[Kind, dict[str, tuple[Spec, bool]]]]] = {
    # requests
    "hello": ("request", {}),
    "scan": ("request", {"timeout_ms": (Num(500, 10_000, integer=True), False)}),
    "play": (
        "request",
        {"device": (DEVICE, True), "url": (Url(), True), "title": (NAME, False), "position": (POSITION, False)},
    ),
    "control": (
        "request",
        {
            "device": (DEVICE, True),
            "action": (OneOf(frozenset({"pause", "resume", "seek"})), True),
            "position": (POSITION, False),
        },
    ),
    "stop": ("request", {"device": (DEVICE, True)}),
    "pair_begin": ("request", {"device": (DEVICE, True)}),
    "pair_pin": ("request", {"device": (DEVICE, True), "pin": (Pattern(r"[0-9]{4,8}"), True)}),
    "mirror_start": (
        "request",
        {
            "device": (DEVICE, True),
            # absent: video only. The only format the host takes is what it wraps as uncompressed ALAC.
            "audio": (
                Obj(
                    {
                        "format": (OneOf(frozenset({"pcm_s16"})), True),
                        "rate": (Num(44100, 44100, integer=True), True),
                        "channels": (Num(2, 2, integer=True), True),
                    }
                ),
                False,
            ),
        },
    ),
    "mirror_stop": ("request", {"session": (SESSION, True)}),
    # responses
    "devices": ("response", {"devices": (Devices(), True)}),
    "ok": ("response", {}),
    "error": ("response", {"code": (ERROR_CODES, True)}),
    "mirror_started": ("response", {"session": (SESSION, True)}),
    # events
    "status": (
        "event",
        {
            "device": (DEVICE, True),
            "state": (STATES, True),
            "position": (POSITION, False),
            "duration": (POSITION, False),
        },
    ),
    "mirror_status": (
        "event",
        {
            "session": (SESSION, True),
            "state": (OneOf(frozenset({"mirroring", "stopped"})), True),
            "reason": (ERROR_CODES, False),
            "codec": (VIDEO_CODECS, False),
            "width": (DIMENSION, False),
            "height": (DIMENSION, False),
            "dropped": (Num(0, 2**53, integer=True), False),
        },
    ),
    # notifications
    "video": (
        "notification",
        {
            "session": (SESSION, True),
            "ts": (MEDIA_TS, True),
            "key": (Bool(), True),
            "data": (Base64(MAX_VIDEO_CHUNK), True),  # NAL units, each with a 4-byte big-endian length
            # required with the first keyframe and whenever the decoder setup changes
            "config": (
                Obj(
                    {
                        "codec": (VIDEO_CODECS, True),
                        "record": (Base64(64 * 1024), True),  # avcC / hvcC
                        "width": (DIMENSION, True),
                        "height": (DIMENSION, True),
                    }
                ),
                False,
            ),
        },
    ),
    "audio": (
        "notification",
        {
            "session": (SESSION, True),
            "ts": (MEDIA_TS, True),
            "data": (Base64(MAX_AUDIO_CHUNK), True),  # interleaved s16le stereo, 44.1 kHz
        },
    ),
}

# hello is both a request and its response; the response carries the host's version.
_HELLO_RESPONSE_FIELDS: Final[dict[str, tuple[Spec, bool]]] = {"host": (Str(32), True)}


def parse(raw: object) -> dict[str, object]:
    """Validate any protocol message and return it unchanged, or raise ProtocolError."""
    if not isinstance(raw, dict):
        raise ProtocolError("invalid_message")
    message: dict[str, object] = raw
    version = message.get("v")
    if not _is_int(version):
        raise ProtocolError("invalid_message")
    if version != VERSION:
        raise ProtocolError("unsupported_version")
    kind_type = message.get("type")
    if not isinstance(kind_type, str):
        raise ProtocolError("invalid_message")
    if kind_type not in MESSAGES:
        raise ProtocolError("unknown_type")
    kind, fields = MESSAGES[kind_type]
    if kind_type == "hello" and "host" in message:
        kind, fields = "response", _HELLO_RESPONSE_FIELDS

    if "id" in message:
        _check(ID, message["id"])
        if kind in ("event", "notification"):
            raise ProtocolError("invalid_message")
    elif kind == "request" or (kind == "response" and kind_type != "error"):
        raise ProtocolError("invalid_message")

    _check_fields(message, fields, extra={"v", "type", "id"})
    if kind_type == "control" and message["action"] == "seek" and "position" not in message:
        raise ProtocolError("invalid_message")
    return message


def error(code: ErrorCode, request_id: object = None) -> dict[str, object]:
    message: dict[str, object] = {"v": VERSION, "type": "error", "code": code}
    if isinstance(request_id, str) and 0 < len(request_id) <= ID.max_len:
        message["id"] = request_id
    return message


def _check_fields(obj: dict[str, object], fields: dict[str, tuple[Spec, bool]], extra: set[str]) -> None:
    allowed = fields.keys() | extra
    if any(key not in allowed for key in obj):
        raise ProtocolError("invalid_message")
    for name, (spec, required) in fields.items():
        if name in obj:
            _check(spec, obj[name])
        elif required:
            raise ProtocolError("invalid_message")


_BASE64 = re.compile(r"[A-Za-z0-9+/]*={0,2}")


def _is_int(value: object) -> bool:
    return isinstance(value, int) and not isinstance(value, bool)


def _check(spec: Spec, value: object) -> None:
    match spec:
        case Str(max_len):
            if not isinstance(value, str) or not 0 < len(value) <= max_len:
                raise ProtocolError("invalid_message")
        case Num(low, high, integer):
            if not (_is_int(value) or isinstance(value, float)) or (integer and not _is_int(value)):
                raise ProtocolError("invalid_message")
            assert isinstance(value, int | float)
            if value < low or (high is not None and value > high):
                raise ProtocolError("invalid_message")
        case OneOf(values):
            if not isinstance(value, str) or value not in values:
                raise ProtocolError("invalid_message")
        case Url():
            _check_url(value)
        case Pattern(regex):
            if not isinstance(value, str) or len(value) > 256 or re.fullmatch(regex, value) is None:
                raise ProtocolError("invalid_message")
        case Bool():
            if not isinstance(value, bool):
                raise ProtocolError("invalid_message")
        case Base64(max_bytes):
            # Shape and size only (non-empty, padded, base64 alphabet); the host decodes when it uses the data.
            if (
                not isinstance(value, str)
                or not value
                or len(value) % 4
                or len(value) > (max_bytes + 2) // 3 * 4
                or _BASE64.fullmatch(value) is None
            ):
                raise ProtocolError("invalid_message")
        case Obj(fields):
            if not isinstance(value, dict):
                raise ProtocolError("invalid_message")
            _check_fields(value, fields, extra=set())
        case Devices(max_items):
            if not isinstance(value, list) or len(value) > max_items:
                raise ProtocolError("invalid_message")
            for device in value:
                _check_device(device)


def _check_url(value: object) -> None:
    if not isinstance(value, str) or not 0 < len(value) <= URL_MAX:
        raise ProtocolError("invalid_message")
    try:
        parts = urlsplit(value)
    except ValueError as e:
        raise ProtocolError("unsupported_url") from e
    if parts.scheme not in ("http", "https") or not parts.hostname:
        raise ProtocolError("unsupported_url")


def _check_device(value: object) -> None:
    if not isinstance(value, dict) or any(key not in ("id", "name", "model") for key in value):
        raise ProtocolError("invalid_message")
    device: dict[str, object] = value
    if "id" not in device or "name" not in device:
        raise ProtocolError("invalid_message")
    _check(DEVICE, device["id"])
    _check(NAME, device["name"])
    if "model" in device:
        _check(NAME, device["model"])
