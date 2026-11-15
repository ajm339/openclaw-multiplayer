import { runInNewContext } from "node:vm";
import { JSDOM } from "jsdom";
import { describe, expect, it, vi } from "vitest";
import { meetStatusScript } from "./google-meet-page-scripts.js";

const URL = "https://meet.google.com/abc-defg-hij";

function createAudioPage() {
  const { window } = new JSDOM(
    `<body>
    <select aria-label="Microphone" hidden><option>Stale device</option></select>
    <button aria-label="Turn off camera"></button>
    <div role="dialog">Camera not found<button aria-label="Close"></button></div>
    <button aria-label="Turn on microphone"></button>
    <button aria-label="Audio settings"></button>
    <button aria-label="Microphone: Default" id="microphone"></button>
    <div role="menu" id="microphone-menu" hidden>
      <div role="menuitemradio" hidden>OpenClaw Meeting Audio</div>
      <div role="menuitemradio">OpenClaw Meeting Audio</div>
    </div>
    <button aria-label="Speaker: Default" id="speaker"></button>
    <div role="menu" id="speaker-menu" hidden>
      <div role="menuitemradio">OpenClaw Meeting Audio Speaker</div>
    </div>
    <button aria-label="Leave call"></button>
    <video id="self-video"></video>
  </body>`,
    { url: URL },
  );
  const document = window.document;
  Object.defineProperty(window.HTMLElement.prototype, "getClientRects", {
    value(this: HTMLElement) {
      return this.closest("[hidden]") ? [] : [{ width: 20, height: 20 }];
    },
  });
  const camera = document.querySelector('[aria-label="Turn off camera"]')!;
  camera.addEventListener("click", () => camera.setAttribute("aria-label", "Turn on camera"));
  document.querySelector('[aria-label="Close"]')!.addEventListener("click", () => {
    document.querySelector('[role="dialog"]')!.setAttribute("hidden", "");
  });
  const mute = document.querySelector('[aria-label="Turn on microphone"]')!;
  mute.addEventListener("click", () => mute.setAttribute("aria-label", "Turn off microphone"));
  const microphone = document.querySelector("#microphone")!;
  microphone.addEventListener("click", () =>
    document.querySelector("#microphone-menu")!.removeAttribute("hidden"),
  );
  for (const option of document.querySelectorAll("#microphone-menu [role=menuitemradio]")) {
    option.addEventListener("click", () => {
      microphone.setAttribute("aria-label", "Microphone: OpenClaw Meeting Audio");
      document.querySelector("#microphone-menu")!.setAttribute("hidden", "");
    });
  }
  const speaker = document.querySelector("#speaker")!;
  speaker.addEventListener("click", () =>
    document.querySelector("#speaker-menu")!.removeAttribute("hidden"),
  );
  document.querySelector("#speaker-menu [role=menuitemradio]")!.addEventListener("click", () => {
    speaker.setAttribute("aria-label", "Speaker: OpenClaw Meeting Audio Speaker");
    document.querySelector("#speaker-menu")!.setAttribute("hidden", "");
  });
  const selfVideoSink = vi.fn(async () => {
    throw new Error("No audio track");
  });
  Object.assign(document.querySelector("#self-video")!, {
    srcObject: { getAudioTracks: () => [] },
    setSinkId: selfVideoSink,
  });
  const devices = [
    { deviceId: "microphone", kind: "audioinput", label: "OpenClaw Meeting Audio" },
    { deviceId: "injection", kind: "audiooutput", label: "OpenClaw Meeting Audio" },
    { deviceId: "speaker", kind: "audiooutput", label: "OpenClaw Meeting Audio Speaker" },
  ];
  return {
    document,
    microphone,
    speaker,
    camera,
    selfVideoSink,
    async status(readOnly = false) {
      const result = await runInNewContext(
        `(${meetStatusScript({
          allowMicrophone: true,
          autoJoin: false,
          captureCaptions: false,
          guestName: "Meeting Assistant",
          readOnly,
        })})()`,
        {
          window,
          document,
          navigator: { mediaDevices: { enumerateDevices: async () => devices } },
          location: window.location,
          Event: window.Event,
          setTimeout: (callback: () => void) => {
            callback();
            return 1;
          },
          clearTimeout,
        },
      );
      return JSON.parse(result) as Record<string, unknown>;
    },
  };
}

describe("Meet audio controls", () => {
  it("uses the visible current picker and prepares silent-room audio without routing a video-only stream", async () => {
    const page = createAudioPage();
    const health = await page.status();
    expect(health).toMatchObject({
      inCall: true,
      micMuted: false,
      audioInputRouted: true,
      audioOutputRouted: true,
      audioOutputDeviceLabel: "OpenClaw Meeting Audio Speaker",
    });
    expect(health.manualAction).toBeUndefined();
    expect(page.microphone.getAttribute("aria-label")).toBe("Microphone: OpenClaw Meeting Audio");
    expect(page.speaker.getAttribute("aria-label")).toBe("Speaker: OpenClaw Meeting Audio Speaker");
    expect(page.camera.getAttribute("aria-label")).toBe("Turn on camera");
    expect(page.document.querySelector('[role="dialog"]')!.hasAttribute("hidden")).toBe(true);
    expect(page.selfVideoSink).not.toHaveBeenCalled();
  });

  it("does not change camera, microphone or speaker choices during read-only inspection", async () => {
    const page = createAudioPage();
    const before = page.document.body.innerHTML;
    const health = await page.status(true);
    expect(page.document.body.innerHTML).toBe(before);
    expect(health).toMatchObject({
      audioInputRouted: false,
      audioOutputRouted: false,
      manualAction: { reason: "meet-audio-choice-required" },
    });
  });
});
