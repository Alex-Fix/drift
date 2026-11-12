"""pyatv code paths that break on dependency updates, exercised offline (no receiver needed)."""

from pyatv.auth.hap_srp import SRPAuthHandler


def test_hap_pairing_can_start_an_srp_session() -> None:
    # The first pairing step builds an SRP client session; with srptools 2.0 this raised a TypeError inside pyatv.
    handler = SRPAuthHandler()
    handler.initialize()
    handler.step1(1234)


def test_mirroring_internals_are_where_pyatv_control_expects_them() -> None:
    import inspect

    from pyatv.auth.hap_channel import setup_channel
    from pyatv.protocols.airplay.auth import extract_credentials, verify_connection
    from pyatv.protocols.airplay.channels import EventChannel
    from pyatv.protocols.airplay.player import timing_server
    from pyatv.protocols.raop.protocols import airplayv2
    from pyatv.support.http import HttpResponse, decode_bplist_from_body, http_connect
    from pyatv.support.rtsp import RtspSession

    assert (airplayv2.EVENTS_SALT, airplayv2.EVENTS_READ_INFO, airplayv2.EVENTS_WRITE_INFO) == (
        "Events-Salt",
        "Events-Read-Encryption-Key",
        "Events-Write-Encryption-Key",
    )
    assert list(inspect.signature(setup_channel).parameters)[:7] == [
        "factory", "verifier", "address", "port", "salt", "output_info", "input_info",
    ]  # fmt: skip
    assert {"method", "uri", "body", "allow_error"} <= set(inspect.signature(RtspSession.exchange).parameters)
    assert hasattr(EventChannel, "handle_received") and hasattr(EventChannel, "parse_request")
    assert HttpResponse._fields == ("protocol", "version", "code", "message", "headers", "body")
    for function in (extract_credentials, verify_connection, timing_server, decode_bplist_from_body, http_connect):
        assert callable(function)
