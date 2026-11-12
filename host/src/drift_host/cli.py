"""drift-host entry point.

The browser starts the host as `drift-host chrome-extension://<id>/` (plus `--parent-window=<n>` on Windows); every
other invocation is a developer command.
"""

import argparse
import asyncio
import logging
import sys
import time
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
    mirror_file.add_argument("clip", type=Path)
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
                return asyncio.run(_mirror_file(parsed.device, parsed.clip, loop=parsed.loop))
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


async def _mirror_file(device: str, path: Path, *, loop: bool) -> int:
    from drift_host.mirror import mp4
    from drift_host.mirror.clock import ntp_after, ntp_now
    from drift_host.mirror.session import MirrorError, MirrorSession
    from drift_host.mirror.video import VideoStream
    from drift_host.protocol import ProtocolError

    try:
        clip = mp4.read_clip(path)
    except (OSError, mp4.ClipError) as e:
        print(f"can't play {path}: {e}", file=sys.stderr)
        return 1
    duration = clip.samples[-1].time + (clip.samples[-1].time / max(1, len(clip.samples) - 1))
    config = clip.config
    print(f"{path.name}: {config.codec} {config.width}x{config.height}, {len(clip.samples)} frames, {duration:.1f}s")

    receivers = PyatvReceivers(credentials_path())
    session: MirrorSession | None = None
    try:
        if device not in {d.id for d in await receivers.scan(4)}:
            print(f"{device} not found — run `drift-host scan`", file=sys.stderr)
            return 1
        session = MirrorSession(await receivers.open_mirror(device))
        await session.start()
        stream = VideoStream(session, clip.config)
        start, ntp_start, offset = time.monotonic(), ntp_now(), 0.0
        while True:
            for sample, data in zip(clip.samples, mp4.read_samples(path, clip.samples), strict=True):
                at = offset + sample.time
                await asyncio.sleep(max(0.0, start + at - time.monotonic()))
                await stream.send(data, keyframe=sample.keyframe, timestamp=ntp_after(ntp_start, at))
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
