"""PyInstaller entry point: the packaged drift-host is this script plus everything it imports."""

from drift_host.cli import main

raise SystemExit(main())
