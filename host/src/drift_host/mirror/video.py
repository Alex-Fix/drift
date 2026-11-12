"""Video over a mirroring session: decoder setup before keyframes, then encrypted access units."""

from drift_host.mirror import packets
from drift_host.mirror.packets import VideoConfig
from drift_host.mirror.session import MirrorSession


class VideoStream:
    def __init__(self, session: MirrorSession, config: VideoConfig) -> None:
        self._session = session
        self._config = config
        self._sealer = packets.FrameSealer(session.stream_key)
        self._sent_config = False

    def reconfigure(self, config: VideoConfig) -> None:
        """New decoder setup (resolution or codec change); sent with the next frame."""
        self._config = config
        self._sent_config = False

    async def send(self, access_unit: bytes, *, keyframe: bool, timestamp: int) -> None:
        """Send one access unit. The first frame (and the first after reconfigure) must be a keyframe."""
        if not self._sent_config and not keyframe:
            raise ValueError("the stream must start with a keyframe")
        if keyframe:
            # Receivers expect the decoder setup with every keyframe (as Apple senders do); it's a few hundred bytes.
            await self._session.send(packets.codec_packet(self._config, timestamp))
            self._sent_config = True
        await self._session.send(self._sealer.seal(access_unit, keyframe=keyframe, timestamp=timestamp))
