import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  resetGatewayWorkAdmission,
  tryBeginGatewayRootWorkAdmission,
} from "../process/gateway-work-admission.js";
import { beginSessionWorkAdmission } from "../sessions/session-lifecycle-admission.js";
import type { RealtimeVoiceBridgeSession } from "../talk/session-runtime.js";

const consultRealtimeVoiceAgent = vi.hoisted(() => vi.fn(async () => ({ text: "done" })));

vi.mock("../talk/agent-consult-runtime.js", () => ({ consultRealtimeVoiceAgent }));

import { createMeetingRealtimeEngineBindings } from "./agent-consult.js";
import type {
  MeetingAgentConsultSurface,
  MeetingPlatformRuntimeMetadata,
} from "./platform-adapter-contract.js";

const surface: MeetingAgentConsultSurface = {
  id: "test-meeting",
  provider: "test-meeting",
  lane: "test-meeting",
  surface: "a test meeting",
  userLabel: "Participant",
  assistantLabel: "Agent",
  questionSourceLabel: "participant",
  workingResponseLabel: "participant",
  extraSystemPrompt: "Answer briefly.",
};

const platform: MeetingPlatformRuntimeMetadata = {
  id: "test-meeting",
  displayName: "Test Meeting",
  logScope: "[test-meeting]",
  agentConsult: {
    surface: surface.surface,
    userLabel: surface.userLabel,
    assistantLabel: surface.assistantLabel,
    questionSourceLabel: surface.questionSourceLabel,
    workingResponseLabel: surface.workingResponseLabel,
    extraSystemPrompt: surface.extraSystemPrompt,
  },
  session: {
    idPrefix: "test_meeting",
    participantIdentity: () => "Test participant",
  },
};

function createBindings(agentId: string | undefined) {
  return createMeetingRealtimeEngineBindings({
    platform,
    config: {
      realtime: { ...(agentId ? { agentId } : {}), toolPolicy: "safe-read-only" },
    },
    fullConfig: { agents: { entries: { operator: {} } } },
    runtime: { agent: {} } as never,
    logger: {} as never,
  });
}

function makeSession(
  submitToolResult: RealtimeVoiceBridgeSession["submitToolResult"],
  supportsToolResultContinuation = false,
): RealtimeVoiceBridgeSession {
  return {
    bridge: { supportsToolResultContinuation },
    submitToolResult,
  } as unknown as RealtimeVoiceBridgeSession;
}

describe("createMeetingRealtimeEngineBindings", () => {
  beforeEach(() => {
    resetGatewayWorkAdmission();
    consultRealtimeVoiceAgent.mockReset();
    consultRealtimeVoiceAgent.mockResolvedValue({ text: "done" });
  });

  it("admits a participant question after its initiating join request finishes", async () => {
    consultRealtimeVoiceAgent.mockImplementation(async () => {
      const work = await beginSessionWorkAdmission({
        scope: "test:meeting-consult",
        identities: ["question"],
      });
      try {
        return await work.run(async () => ({ text: "Two plus two is four." }));
      } finally {
        work.release();
      }
    });
    const join = tryBeginGatewayRootWorkAdmission("test:meeting-join");
    if (!join) {
      throw new Error("Expected the join request to be admitted");
    }
    let ask = () => {};
    const question = new Promise<void>((resolve) => {
      ask = resolve;
    });
    const answer = join.run(async () => {
      await question;
      return await createBindings("Support").consultAgent({
        meetingSessionId: "meeting-after-join",
        args: { question: "What is two plus two?" },
        transcript: [],
      });
    });
    join.release();
    ask();

    await expect(answer).resolves.toEqual({ text: "Two plus two is four." });
  });

  it("does not start agent work after the meeting has been stopped", async () => {
    const controller = new AbortController();
    controller.abort(new Error("Meeting stopped"));
    await expect(
      createBindings("Support").consultAgent({
        meetingSessionId: "stopped-meeting",
        args: { question: "What is two plus two?" },
        transcript: [],
        abortSignal: controller.signal,
      }),
    ).rejects.toThrow("Meeting stopped");
    expect(consultRealtimeVoiceAgent).not.toHaveBeenCalled();
  });

  it("targets the configured default agent when agentId is omitted", async () => {
    await createBindings(undefined).consultAgent({
      meetingSessionId: "meeting-1",
      args: { question: "What should I say?" },
      transcript: [],
    });

    expect(consultRealtimeVoiceAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: "operator",
        sessionKey: "agent:operator:subagent:test-meeting:meeting-1",
        spawnedBy: "agent:operator:main",
      }),
    );
  });

  it("derives realtime engine bindings from platform metadata", async () => {
    const bindings = createBindings("Support");

    expect(bindings.platform).toEqual({
      displayName: "Test Meeting",
      logScope: "[test-meeting]",
      sessionIdPrefix: "test-meeting",
    });
    await bindings.consultAgent({
      meetingSessionId: "meeting-3",
      args: { question: "What should I say?" },
      transcript: [],
    });

    expect(consultRealtimeVoiceAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: "support",
        messageProvider: "test-meeting",
        lane: "test-meeting",
        surface: "a test meeting",
        sessionKey: "agent:support:subagent:test-meeting:meeting-3",
        spawnedBy: "agent:support:main",
      }),
    );
  });

  it("emits a final tool event only after the bridge accepts the result", async () => {
    let acceptResult = () => {};
    const accepted = new Promise<void>((resolve) => {
      acceptResult = resolve;
    });
    const submitToolResult = vi.fn(() => accepted);
    const events: Array<{ type: string; final?: boolean }> = [];

    const handled = createBindings("Support").handleToolCall({
      strategy: "agent",
      session: makeSession(submitToolResult),
      event: {
        itemId: "item-1",
        callId: "call-1",
        name: "openclaw_agent_consult",
        args: { question: "What should I say?" },
      },
      meetingSessionId: "meeting-4",
      transcript: [],
      onTalkEvent: (event) => events.push(event),
    });

    expect(submitToolResult).toHaveBeenCalledTimes(1);
    expect(events).toEqual([]);
    acceptResult();
    await handled;
    expect(events).toEqual([expect.objectContaining({ type: "tool.error", final: true })]);
  });

  it("does not retry a rejected result submission as a second tool error", async () => {
    const submitToolResult = vi.fn(async () => {
      throw new Error("result delivery failed");
    });
    const events: Array<{ type: string }> = [];

    await expect(
      createBindings("Support").handleToolCall({
        strategy: "bidi",
        session: makeSession(submitToolResult),
        event: {
          itemId: "item-1",
          callId: "call-1",
          name: "openclaw_agent_consult",
          args: { question: "What should I say?" },
        },
        meetingSessionId: "meeting-5",
        transcript: [],
        onTalkEvent: (event) => events.push(event),
      }),
    ).rejects.toThrow("result delivery failed");

    expect(consultRealtimeVoiceAgent).toHaveBeenCalledTimes(1);
    expect(submitToolResult).toHaveBeenCalledTimes(1);
    expect(events.map((event) => event.type)).toEqual(["tool.progress"]);
  });
});
