"""drift-host entry point.

The browser starts the host as `drift-host chrome-extension://<id>/` (plus `--parent-window=<n>` on Windows); every
other invocation is a developer command.
"""

import argparse
import asyncio
import logging
import sys
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
    for name in ("install", "uninstall"):
        command = commands.add_parser(name, help=f"{name} the native-messaging host for a browser")
        command.add_argument("--extension-id", required=True, help="the id shown on chrome://extensions")
        command.add_argument("--browser", choices=install.BROWSERS, default="chrome")
    parsed = parser.parse_args(args)

    match parsed.command:
        case "scan":
            return asyncio.run(_scan(parsed.timeout))
        case "pair":
            return asyncio.run(_pair(parsed.device))
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


async def _pair(device: str) -> int:
    from drift_host.protocol import ProtocolError

    receivers = PyatvReceivers(credentials_path())
    try:
        if device not in {d.id for d in await receivers.scan(5)}:
            print(f"{device} not found — run `drift-host scan`", file=sys.stderr)
            return 1
        await receivers.pair(device, lambda: asyncio.to_thread(input, "PIN shown on the receiver: "))
    except (ProtocolError, ValueError) as e:
        # Developer command: pyatv's reason (e.g. a wrong PIN) is more useful here than the protocol code alone.
        print(f"pairing failed: {e}" + (f" ({e.__cause__})" if e.__cause__ else ""), file=sys.stderr)
        return 1
    finally:
        await receivers.close()
    print(f"paired; credentials saved to {credentials_path()}")
    return 0
