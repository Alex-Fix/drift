"""Smoke-test a drift-host executable (a packaged build, or an installed one):
`--version`, `check` (every module loads), and a native-messaging `hello` as the browser sends it.

Usage: python smoke.py <path to drift-host> [expected version]
"""

import json
import struct
import subprocess
import sys

ORIGIN = "chrome-extension://abcdefghijklmnopabcdefghijklmnop/"


def run(binary: str, *args: str, stdin: bytes = b"") -> subprocess.CompletedProcess[bytes]:
    return subprocess.run([binary, *args], input=stdin, capture_output=True, timeout=60, check=False)  # noqa: S603


def main() -> int:
    binary = sys.argv[1]
    expected = sys.argv[2] if len(sys.argv) > 2 else None

    version = run(binary, "--version")
    print(version.stdout.decode().strip())
    assert version.returncode == 0, version.stderr.decode()
    if expected is not None:
        assert version.stdout.decode().strip() == f"drift-host {expected}", f"expected version {expected}"

    check = run(binary, "check")
    print(check.stdout.decode().strip())
    assert check.returncode == 0, check.stderr.decode()

    request = json.dumps({"v": 1, "type": "hello", "id": "smoke"}).encode()
    reply = run(binary, ORIGIN, stdin=struct.pack("=I", len(request)) + request)
    assert len(reply.stdout) >= 4, f"no reply (exit {reply.returncode}): {reply.stderr.decode()}"
    (length,) = struct.unpack("=I", reply.stdout[:4])
    message = json.loads(reply.stdout[4 : 4 + length])
    print(f"hello → {message}")
    assert message["type"] == "hello" and message["id"] == "smoke", message
    if expected is not None:
        assert message["host"] == expected, message
    print("smoke test passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
