import json
import math
import struct
from pathlib import Path

import pytest
from cryptography.hazmat.primitives.ciphers.aead import ChaCha20Poly1305
from pyatv.support.chacha20 import Chacha20Cipher8byteNonce

from drift_host.mirror.audio import ALAC_PACKET_SIZE, BYTES_PER_PACKET, AudioSealer, AudioStream, alac_frame
from drift_host.mirror.session import MirrorSession
from tests.fake_tv import FAST, FakeTV, eventually

GOLDEN = json.loads((Path(__file__).parent / "fixtures" / "mirror" / "golden.json").read_text())


def decode_alac(frame: bytes) -> list[tuple[int, int]]:
    """Independent bit-level reader for uncompressed ALAC stereo frames."""
    bits = int.from_bytes(frame, "big")
    total = len(frame) * 8

    def take(at: int, width: int) -> int:
        return (bits >> (total - at - width)) & ((1 << width) - 1)

    assert take(0, 3) == 1  # stereo pair element
    # 3b element, 4b instance, 12b unused, then: has-size, 2b shift, is-not-compressed
    assert take(19, 1) == 0 and take(20, 2) == 0 and take(22, 1) == 1
    pairs, at = [], 23
    for _ in range(352):
        left, right = take(at, 16), take(at + 16, 16)
        pairs.append((left - (left >> 15 << 16), right - (right >> 15 << 16)))
        at += 32
    assert take(at, 3) == 0b111  # end tag
    return pairs


def stereo(left: list[int], right: list[int]) -> bytes:
    return b"".join(struct.pack("<hh", lv, rv) for lv, rv in zip(left, right, strict=True))


def test_alac_frame_matches_the_tv_verified_bytes() -> None:
    assert alac_frame(bytes.fromhex(GOLDEN["alac"]["pcm"])).hex() == GOLDEN["alac"]["frame"]


def test_alac_frame_keeps_left_and_right_apart_and_in_order() -> None:
    left = [int(30000 * math.sin(n / 7)) for n in range(352)]
    right = [-32768 if n % 2 else 32767 for n in range(352)]
    frame = alac_frame(stereo(left, right))
    assert len(frame) == ALAC_PACKET_SIZE
    assert decode_alac(frame) == list(zip(left, right, strict=True))


def test_alac_frame_needs_exactly_one_packet_of_pcm() -> None:
    with pytest.raises(ValueError):
        alac_frame(bytes(BYTES_PER_PACKET - 4))


def test_audio_sealer_matches_pyatvs_airplay2_audio_cipher() -> None:
    key, header, payload = bytes(range(32)), bytes(range(12)), b"alac" * 100
    ours, theirs = AudioSealer(key), Chacha20Cipher8byteNonce(key, key)
    for _ in range(3):
        nonce = theirs.out_nonce
        expected = header + theirs.encrypt(payload, aad=header[4:12]) + nonce[-8:]
        assert ours.seal(header, payload) == expected


def unseal(key: bytes, packet: bytes) -> tuple[bytes, bytes]:
    header, sealed, nonce_tail = packet[:12], packet[12:-8], packet[-8:]
    return header, ChaCha20Poly1305(key).decrypt(bytes(4) + nonce_tail, sealed, header[4:12])


async def started(tv: FakeTV) -> tuple[MirrorSession, AudioStream]:
    session = MirrorSession(tv, audio=True, timings=FAST)
    await session.start()
    return session, AudioStream(session, start=1000 << 32)


async def test_packets_carry_sequential_rtp_and_decrypt_to_the_pcm_sent() -> None:
    async with FakeTV() as tv:
        session, audio = await started(tv)
        pcm = [stereo([i] * 352, [-i] * 352) for i in range(3)]
        for chunk in pcm:
            audio.send(chunk)
        await eventually(lambda: len(tv.audio_packets) == 3)
        headers = []
        for i, packet in enumerate(tv.audio_packets):
            header, payload = unseal(session.audio.key, packet)
            headers.append(struct.unpack(">BBHII", header))
            assert decode_alac(payload) == [(i, -i)] * 352
        (_, m0, s0, t0, c0), (_, m1, s1, t1, c1), (_, _, s2, t2, _) = headers
        assert (m0, m1) == (0xE0, 0x60)  # marker on the first packet only
        assert ((s1 - s0) & 0xFFFF, (s2 - s1) & 0xFFFF) == (1, 1)
        assert ((t1 - t0) & 0xFFFFFFFF, (t2 - t1) & 0xFFFFFFFF) == (352, 352)
        assert c0 == c1
        await session.stop()


async def test_partial_pcm_waits_for_a_full_packet_and_flush_pads_it() -> None:
    async with FakeTV() as tv:
        session, audio = await started(tv)
        audio.send(bytes(BYTES_PER_PACKET - 40))
        audio.send(bytes(20))
        assert audio.frames_sent == 0
        audio.flush()
        assert audio.frames_sent == 352
        with pytest.raises(ValueError):
            audio.send(b"\x00\x01\x02")
        await session.stop()


async def test_sync_packets_map_rtp_to_the_video_clock_once_a_second() -> None:
    async with FakeTV() as tv:
        session, audio = await started(tv)
        packets_per_second = math.ceil(44100 / 352)
        for _ in range(packets_per_second + 1):
            audio.send(bytes(BYTES_PER_PACKET))
        await eventually(lambda: len(tv.audio_control_packets) == 2)
        first, second = (struct.unpack(">BBHIIII", p) for p in tv.audio_control_packets)
        assert first[:3] == (0x90, 0xD4, 7) and second[:3] == (0x80, 0xD4, 7)
        assert (first[4], first[5]) == (1000, 0)  # NTP of the first sample = the stream start
        assert (first[6] - first[3]) & 0xFFFFFFFF == 11025  # RTP now - latency
        rtp_first = struct.unpack_from(">I", tv.audio_packets[0], 4)[0]
        assert first[6] == rtp_first
        frames_at_second = (second[6] - first[6]) & 0xFFFFFFFF
        assert frames_at_second == packets_per_second * 352
        ntp_second = (second[4] << 32 | second[5]) - (1000 << 32)
        assert ntp_second / 2**32 == pytest.approx(frames_at_second / 44100, abs=1e-6)
        await session.stop()


async def test_retransmit_requests_resend_the_original_packets() -> None:
    async with FakeTV() as tv:
        session, audio = await started(tv)
        for _ in range(5):
            audio.send(bytes(BYTES_PER_PACKET))
        await eventually(lambda: len(tv.audio_packets) == 5)
        first_sequence = struct.unpack_from(">H", tv.audio_packets[0], 2)[0]
        lost = (first_sequence + 2) & 0xFFFF
        tv.send_to_sender_control(struct.pack(">BBHHH", 0x80, 0xD5, 1, lost, 2))
        await eventually(lambda: len([p for p in tv.audio_control_packets if p[1] == 0xD6]) == 2)
        resends = [p for p in tv.audio_control_packets if p[1] == 0xD6]
        assert [p[4:] for p in resends] == tv.audio_packets[2:4]
        assert [struct.unpack_from(">H", p, 2)[0] for p in resends] == [lost, (lost + 1) & 0xFFFF]
        await session.stop()


async def test_retransmit_of_unknown_packets_is_ignored() -> None:
    async with FakeTV() as tv:
        session, audio = await started(tv)
        audio.send(bytes(BYTES_PER_PACKET))
        await eventually(lambda: len(tv.audio_packets) == 1)
        sequence = struct.unpack_from(">H", tv.audio_packets[0], 2)[0]
        tv.send_to_sender_control(struct.pack(">BBHHH", 0x80, 0xD5, 1, (sequence + 100) & 0xFFFF, 60000))
        tv.send_to_sender_control(b"\x80\xd5")  # too short
        await session.stop()
        assert not [p for p in tv.audio_control_packets if p[1] == 0xD6]
