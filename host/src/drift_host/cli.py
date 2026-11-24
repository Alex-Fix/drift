"""drift-host entry point.

The browser starts the host as `drift-host chrome-extension://<id>/` (plus `--parent-window=<n>` on Windows); every
other invocation is a developer command.
"""

import argparse
import asyncio
import logging
import sys
import time
import wave
from pathlib import Path

import platformdirs

from drift_host import install
from drift_host.airplay import PyatvReceivers

APP = "drift"


def main(argv: list[str] | None = None) -> int:
    args = sys.argv[1:] if argv is None else argv
    if args and args[0].startswith("chrome-extension://"):
        return _serve()

    parser = argparse.ArgumentParser(prog="drift-host", description="AirPlay host for the drift browser extension.")
    commands = parser.add_subparsers(dest="command", required=True)
    scan = commands.add_parser("scan", help="list AirPlay receivers on the network")
    scan.add_argument("--timeout", type=float, default=3.0, help="seconds (default 3)")
    pair = commands.add_parser("pair", help="pair with a receiver that asks for a PIN (stores the credentials)")
    pair.add_argument("--device", required=True, help="receiver id, as listed by `drift-host scan`")
    pair.add_argument(
        "--pin-file",
        type=Path,
        help="wait for the PIN to be written to this file instead of prompting (no terminal needed; deleted after)",
    )
    mirror_file = commands.add_parser(
        "mirror-file", help="mirror a pre-encoded MP4 clip (H.264 or HEVC, no B-frames) to a receiver"
    )
    mirror_file.add_argument("--device", required=True, help="receiver id, as listed by `drift-host scan`")
    mirror_file.add_argument("--loop", action="store_true", help="repeat the clip until interrupted")
    mirror_file.add_argument(
        "--audio", type=Path, help="WAV (16-bit stereo, 44.1 kHz) played alongside, cut or padded to the clip's length"
    )
    mirror_file.add_argument("clip", type=Path)
    stream_url = commands.add_parser("stream-url", help="have a receiver play a video URL itself (MP4/MOV or HLS)")
    stream_url.add_argument("--device", required=True, help="receiver id, as listed by `drift-host scan`")
    stream_url.add_argument("--seconds", type=float, default=20.0, help="how long to play before stopping (default 20)")
    stream_url.add_argument("--position", type=float, default=0.0, help="start this many seconds in")
    stream_url.add_argument(
        "--controls", action="store_true", help="halfway through: pause 3 s, jump 30 s ahead, resume"
    )
    stream_url.add_argument("url", help="http(s) URL of an MP4/MOV file or an HLS playlist (.m3u8)")
    for name in ("install", "uninstall"):
        command = commands.add_parser(name, help=f"{name} the native-messaging host for a browser")
        command.add_argument("--extension-id", required=True, help="the id shown on chrome://extensions")
        command.add_argument("--browser", choices=install.BROWSERS, default="chrome")
    parsed = parser.parse_args(args)

    match parsed.command:
        case "scan":
            return asyncio.run(_scan(parsed.timeout))
        case "pair":
            return asyncio.run(_pair(parsed.device, parsed.pin_file))
        case "mirror-file":
            logging.basicConfig(level=logging.INFO, format="%(message)s")
            logging.getLogger("pyatv").setLevel(logging.WARNING)
            try:
                return asyncio.run(_mirror_file(parsed.device, parsed.clip, audio=parsed.audio, loop=parsed.loop))
            except KeyboardInterrupt:
                return 130
        case "stream-url":
            logging.basicConfig(level=logging.INFO, format="%(message)s")
            logging.getLogger("pyatv").setLevel(logging.WARNING)
            try:
                return asyncio.run(
                    _stream_url(
                        parsed.device,
                        parsed.url,
                        seconds=parsed.seconds,
                        position=parsed.position,
                        controls=parsed.controls,
                    )
                )
            except KeyboardInterrupt:
                return 130
        case "install" | "uninstall":
            p = install.plan(
                parsed.browser,
                parsed.extension_id,
                system=install.current_system(),
                home=Path.home(),
                data_dir=Path(platformdirs.user_data_dir(APP, appauthor=False)),
                python=sys.executable,
            )
            if parsed.command == "install":
                install.install(p)
                print(f"installed {install.HOST_NAME} for {parsed.browser}: {p.manifest}")
            else:
                install.uninstall(p)
                print(f"removed {p.manifest}")
            return 0
    return 2


def _serve() -> int:
    from drift_host import app, messaging

    log_dir = Path(platformdirs.user_log_dir(APP, appauthor=False))
    log_dir.mkdir(parents=True, exist_ok=True)
    # Never log to stdout or stderr defaults: stdout is the message channel.
    logging.basicConfig(
        filename=log_dir / "host.log", level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s"
    )
    stdin, stdout = messaging.binary_stdio()
    asyncio.run(app.serve(PyatvReceivers(credentials_path()), stdin, stdout))
    return 0


def credentials_path() -> Path:
    return Path(platformdirs.user_data_dir(APP, appauthor=False)) / "receivers.json"


async def _scan(listen: float) -> int:
    receivers = PyatvReceivers(credentials_path())
    devices = await receivers.scan(listen)
    for device in devices:
        print(f"{device.id}\t{device.name}\t{device.model or ''}")
    if not devices:
        print("no AirPlay receivers found", file=sys.stderr)
    await receivers.close()
    return 0


async def _pair(device: str, pin_file: Path | None) -> int:
    from drift_host.protocol import ProtocolError

    if pin_file is None and not sys.stdin.isatty():
        print(
            "pairing asks for the PIN shown on the receiver: run this in a terminal, or use --pin-file", file=sys.stderr
        )
        return 1
    receivers = PyatvReceivers(credentials_path())
    try:
        if device not in {d.id for d in await receivers.scan(5)}:
            print(f"{device} not found — run `drift-host scan`", file=sys.stderr)
            return 1
        if pin_file is None:
            await receivers.pair(device, lambda: asyncio.to_thread(input, "PIN shown on the receiver: "))
        else:
            await receivers.pair(device, lambda: asyncio.to_thread(_wait_for_pin, pin_file))
    except (ProtocolError, ValueError, TimeoutError) as e:
        # Developer command: pyatv's reason (e.g. a wrong PIN) is more useful here than the protocol code alone.
        print(f"pairing failed: {e}" + (f" ({e.__cause__})" if e.__cause__ else ""), file=sys.stderr)
        return 1
    finally:
        await receivers.close()
    print(f"paired; credentials saved to {credentials_path()}")
    return 0


def _wait_for_pin(path: Path, seconds: float = 180) -> str:
    """Blocking (run in a thread): the PIN once something writes it to `path`, which is then deleted."""
    print(f"waiting for the PIN shown on the receiver in {path}", flush=True)
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        if path.exists() and (pin := path.read_text(encoding="utf-8").strip()):
            path.unlink()
            return pin
        time.sleep(0.5)
    raise TimeoutError("no PIN written in time")


async def _mirror_file(device: str, path: Path, *, audio: Path | None, loop: bool) -> int:
    from drift_host.mirror import mp4
    from drift_host.mirror.audio import AudioStream
    from drift_host.mirror.clock import ntp_after, ntp_now
    from drift_host.mirror.session import AUDIO_FRAMES_PER_PACKET, AUDIO_SAMPLE_RATE, MirrorError, MirrorSession
    from drift_host.mirror.video import VideoStream
    from drift_host.protocol import ProtocolError

    try:
        clip = mp4.read_clip(path)
        pcm = _read_wav(audio) if audio else None
    except (OSError, EOFError, mp4.ClipError, ValueError) as e:
        print(f"can't play: {e}", file=sys.stderr)
        return 1
    duration = clip.samples[-1].time + (clip.samples[-1].time / max(1, len(clip.samples) - 1))
    config = clip.config
    print(
        f"{path.name}: {config.codec} {config.width}x{config.height}, {len(clip.samples)} frames, {duration:.1f}s"
        + (f"; audio {audio.name}" if audio else "")
    )

    receivers = PyatvReceivers(credentials_path())
    session: MirrorSession | None = None
    try:
        if device not in {d.id for d in await receivers.scan(4)}:
            print(f"{device} not found — run `drift-host scan`", file=sys.stderr)
            return 1
        session = MirrorSession(await receivers.open_mirror(device), audio=pcm is not None)
        await session.start()
        video = VideoStream(session, clip.config)
        start, ntp_start = time.monotonic(), ntp_now()
        sound = AudioStream(session, start=ntp_start) if pcm is not None else None

        async def play_video(offset: float) -> None:
            for sample, data in zip(clip.samples, mp4.read_samples(path, clip.samples), strict=True):
                at = offset + sample.time
                await asyncio.sleep(max(0.0, start + at - time.monotonic()))
                await video.send(data, keyframe=sample.keyframe, timestamp=ntp_after(ntp_start, at))

        async def play_audio(offset: float) -> None:
            assert sound is not None and pcm is not None
            # Frame counts are global so repeated loops don't drift by a partial packet each time.
            first, end = round(offset * AUDIO_SAMPLE_RATE), round((offset + duration) * AUDIO_SAMPLE_RATE)
            while sound.frames_sent < end:
                at = sound.frames_sent / AUDIO_SAMPLE_RATE
                await asyncio.sleep(max(0.0, start + at - time.monotonic()))
                frame = sound.frames_sent - first
                chunk = pcm[frame * 4 : (frame + AUDIO_FRAMES_PER_PACKET) * 4]
                sound.send(chunk + bytes(AUDIO_FRAMES_PER_PACKET * 4 - len(chunk)))

        offset = 0.0
        while True:
            await asyncio.gather(play_video(offset), *([play_audio(offset)] if sound else []))
            if not loop:
                break
            offset += duration
        await asyncio.sleep(1)  # let the receiver show the last frames
    except (ProtocolError, MirrorError, ConnectionError, mp4.ClipError) as e:
        print(f"mirroring failed: {e}", file=sys.stderr)
        return 1
    finally:
        if session is not None:
            await session.stop()
        await receivers.close()
    return 0


async def _stream_url(device: str, url: str, *, seconds: float, position: float, controls: bool) -> int:
    from urllib.parse import urlsplit

    from drift_host.playback import MediaType, PlaybackError, PlaybackInfo, PlaybackSession
    from drift_host.protocol import ProtocolError

    parts = urlsplit(url)
    if parts.scheme not in ("http", "https") or not parts.hostname:
        print("the URL must be http(s)", file=sys.stderr)
        return 1
    media_type: MediaType = "streaming" if parts.path.lower().endswith(".m3u8") else "file"

    def show(info: PlaybackInfo) -> None:
        def fmt(value: float | None) -> str:
            return "—" if value is None else f"{value:.1f}s"

        print(f"  {info.state or '?'}: {fmt(info.position)} / {fmt(info.duration)}, {fmt(info.buffered)} buffered")

    receivers = PyatvReceivers(credentials_path())
    session: PlaybackSession | None = None
    try:
        if device not in {d.id for d in await receivers.scan(4)}:
            print(f"{device} not found — run `drift-host scan`", file=sys.stderr)
            return 1
        session = PlaybackSession(await receivers.open_playback(device), on_state=lambda state: print(f"→ {state}"))
        await session.start()
        await session.load(url, media_type, position)
        print(f"loaded as {media_type}; playing for {seconds:.0f}s")
        started = time.monotonic()
        controlled = not controls
        while (elapsed := time.monotonic() - started) < seconds and not session.ended.is_set():
            await asyncio.sleep(2)
            show(await session.info())
            if not controlled and elapsed >= seconds / 2:
                controlled = True
                print("pause")
                await session.pause()
                await asyncio.sleep(3)
                show(await session.info())
                landed = await session.seek(((await session.info()).position or 0) + 30)
                print(f"seek +30s → {landed}")
                print("resume")
                await session.resume()
        if session.ended.is_set():
            print("the receiver ended the session", file=sys.stderr)
            return 1
    except (ProtocolError, PlaybackError, ConnectionError, TimeoutError) as e:
        print(f"playback failed: {e}", file=sys.stderr)
        return 1
    finally:
        if session is not None:
            await session.stop()
        await receivers.close()
    return 0


def _read_wav(path: Path) -> bytes:
    """Interleaved s16le stereo PCM at 44.1 kHz — the format the browser will send; no resampling here."""
    with wave.open(str(path), "rb") as wav:
        if (wav.getnchannels(), wav.getsampwidth(), wav.getframerate(), wav.getcomptype()) != (2, 2, 44100, "NONE"):
            raise ValueError(f"{path.name}: needs 16-bit stereo PCM at 44.1 kHz")
        return wav.readframes(wav.getnframes())
