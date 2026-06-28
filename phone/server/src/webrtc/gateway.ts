export type WebRtcOffer = {
  callId: string;
  fromExtension: string;
  sdp: string;
};

export class WebRtcGateway {
  readonly mode = "websocket-push-to-talk";

  describe() {
    return {
      mode: this.mode,
      implementedAudioPath: "WebSocket JSON signaling plus base64 push-to-talk audio chunks",
      nextUpgrade: "Terminate WebRTC in a media bridge or deploy a dedicated SFU/gateway on the Proxmox VM."
    };
  }

  createOfferResponse(offer: WebRtcOffer) {
    return {
      type: "error",
      callId: offer.callId,
      code: "webrtc_not_enabled",
      message: "WebRTC signaling is reserved for the next upgrade. Use audio_start/audio_chunk/audio_end WebSocket events."
    };
  }
}
