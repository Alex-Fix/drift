"""Audio over a mirroring session: raw PCM in, encrypted RTP of uncompressed ALAC out (spike step 4).

Input is interleaved signed 16-bit little-endian stereo PCM at 44.1 kHz (what the browser sends). Every 352 frames
become one uncompressed ALAC packet, sealed with ChaCha20-Poly1305 under the stream's `shk`. Once a second a sync
packet maps RTP time to NTP time on the video's clock, which keeps audio and picture together.
"""

import array
import secrets
import struct
import sys
from collections import OrderedDict

from cryptography.hazmat.primitives.ciphers.aead import ChaCha20Poly1305

from drift_host.mirror.clock import ntp_after
from drift_host.mirror.session import (
    AUDIO_FRAMES_PER_PACKET,
    AUDIO_LATENCY,
    AUDIO_SAMPLE_RATE,
    MirrorSession,
)

BYTES_PER_PACKET = AUDIO_FRAMES_PER_PACKET * 4  # stereo, 16-bit
ALAC_PACKET_SIZE = 1412  # 23 header bits + 352 x 32 sample bits + 3 end bits, byte-aligned

_RTP_HEADER = struct.Struct(">BBHII")  # version/flags, marker+payload type, sequence, timestamp, ssrc
_SYNC = struct.Struct(">BBHIIII")  # flags, type 0xD4, 0x0007, RTP now - latency, NTP seconds, NTP fraction, RTP now
_MASK32 = 0xFFFFFFFF
_RETRANSMIT_REQUEST = 0x55
_MAX_RESEND = 64  # packets per request; bounds the work a malformed request can cause
_BACKLOG = 2 * AUDIO_SAMPLE_RATE // AUDIO_FRAMES_PER_PACKET  # ~2 s of packets kept for resends

# Uncompressed ALAC frame header, MSB first: 3b element = CPE (stereo pair), 4b instance tag, 12b unused,
# 1b has-size = 0, 2b shift = 0, 1b is-not-compressed = 1.
_ALAC_HEADER = 1 << 20 | 1
_ALAC_SAMPLE_BITS = AUDIO_FRAMES_PER_PACKET * 2 * 16
_ALAC_PAD = ALAC_PACKET_SIZE * 8 - (23 + _ALAC_SAMPLE_BITS + 3)


def alac_frame(pcm: bytes) -> bytes:
    """352 interleaved s16le stereo frames → one uncompressed ALAC frame (samples big-endian, after a 23-bit header,
    then the 3-bit end tag, zero-padded to a byte)."""
    if len(pcm) != BYTES_PER_PACKET:
        raise ValueError(f"an ALAC frame takes {BYTES_PER_PACKET} bytes of PCM")
    samples = array.array("h")
    samples.frombytes(pcm)
    if sys.byteorder == "little":
        samples.byteswap()
    body = int.from_bytes(samples.tobytes(), "big")
    bits = ((_ALAC_HEADER << _ALAC_SAMPLE_BITS | body) << 3 | 0b111) << _ALAC_PAD
    return bits.to_bytes(ALAC_PACKET_SIZE, "big")


class AudioSealer:
    """ChaCha20-Poly1305 over the payload; AAD = RTP header bytes 4-12 (timestamp, ssrc); nonce = 4 zero bytes +
    LE64 counter, whose last 8 bytes follow the sealed payload."""

    def __init__(self, key: bytes) -> None:
        self._aead = ChaCha20Poly1305(key)
        self._counter = 0

    def seal(self, rtp_header: bytes, payload: bytes) -> bytes:
        nonce = bytes(4) + struct.pack("<Q", self._counter)
        self._counter += 1
        return rtp_header + self._aead.encrypt(nonce, payload, rtp_header[4:12]) + nonce[4:]


class AudioStream:
    def __init__(self, session: MirrorSession, start: int) -> None:
        """`start`: NTP time of the first sample, on the same clock and origin as the video timestamps."""
        self._channel = session.audio
        self._channel.on_control = self._on_control
        self._sealer = AudioSealer(self._channel.key)
        self._start = start
        self._sequence = secrets.randbits(16)
        self._ssrc = secrets.randbits(32)
        self._rtp_base = secrets.randbits(32)
        self._frames = 0  # sent so far
        self._next_sync = 0
        self._pending = bytearray()
        self._backlog: OrderedDict[int, bytes] = OrderedDict()

    @property
    def frames_sent(self) -> int:
        return self._frames

    def send(self, pcm: bytes) -> None:
        """Queue PCM (any whole number of frames); full packets go out at once. Call at playback pace."""
        if len(pcm) % 4:
            raise ValueError("PCM must be whole stereo s16 frames")
        self._pending += pcm
        while len(self._pending) >= BYTES_PER_PACKET:
            chunk = bytes(self._pending[:BYTES_PER_PACKET])
            del self._pending[:BYTES_PER_PACKET]
            self._send_packet(chunk)

    def flush(self) -> None:
        """Send what's buffered, padded with silence to a whole packet."""
        if self._pending:
            self.send(bytes(BYTES_PER_PACKET - len(self._pending)))

    def _send_packet(self, pcm: bytes) -> None:
        if self._frames >= self._next_sync:
            self._send_sync()
            self._next_sync += AUDIO_SAMPLE_RATE
        first = self._frames == 0
        rtp_time = (self._rtp_base + self._frames) & _MASK32
        header = _RTP_HEADER.pack(0x80, 0xE0 if first else 0x60, self._sequence, rtp_time, self._ssrc)
        packet = self._sealer.seal(header, alac_frame(pcm))
        self._channel.send(packet)
        self._backlog[self._sequence] = packet
        if len(self._backlog) > _BACKLOG:
            self._backlog.popitem(last=False)
        self._sequence = (self._sequence + 1) & 0xFFFF
        self._frames += AUDIO_FRAMES_PER_PACKET

    def _send_sync(self) -> None:
        rtp_now = (self._rtp_base + self._frames) & _MASK32
        ntp = ntp_after(self._start, self._frames / AUDIO_SAMPLE_RATE)
        flags = 0x90 if self._frames == 0 else 0x80
        packet = _SYNC.pack(flags, 0xD4, 0x0007, (rtp_now - AUDIO_LATENCY) & _MASK32, ntp >> 32, ntp & _MASK32, rtp_now)
        self._channel.send_control(packet)

    def _on_control(self, data: bytes) -> None:
        if len(data) < 8 or data[1] & 0x7F != _RETRANSMIT_REQUEST:
            return
        first, count = struct.unpack_from(">HH", data, 4)
        for i in range(min(count, _MAX_RESEND)):
            sequence = (first + i) & 0xFFFF
            packet = self._backlog.get(sequence)
            if packet is not None:
                self._channel.send_control(b"\x80\xd6" + struct.pack(">H", sequence) + packet)
