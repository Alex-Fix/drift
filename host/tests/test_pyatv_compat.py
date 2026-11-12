"""pyatv code paths that break on dependency updates, exercised offline (no receiver needed)."""

from pyatv.auth.hap_srp import SRPAuthHandler


def test_hap_pairing_can_start_an_srp_session() -> None:
    # The first pairing step builds an SRP client session; with srptools 2.0 this raised a TypeError inside pyatv.
    handler = SRPAuthHandler()
    handler.initialize()
    handler.step1(1234)
