import { describe, expect, it } from "vitest";
import { createVadState, stepVad, DEFAULT_VAD_CONFIG, type VadState } from "./vad";

const CFG = DEFAULT_VAD_CONFIG;
const LOUD = CFG.silenceRms * 4;
const QUIET = CFG.silenceRms / 4;

// Drive the machine with (rms, at) pairs and return the last step.
function drive(samples: Array<[number, number]>) {
  let state: VadState = createVadState(0);
  let last = { state, action: "none" as string, speaking: false };
  for (const [rms, at] of samples) {
    const step = stepVad(state, rms, at, CFG);
    state = step.state;
    last = step;
    if (step.action !== "none") break;
  }
  return last;
}

describe("stepVad", () => {
  it("stays waiting while quiet", () => {
    const step = drive([
      [QUIET, 50],
      [QUIET, 5000],
      [QUIET, 20000],
    ]);
    expect(step.state.phase).toBe("waiting_for_speech");
    expect(step.action).toBe("none");
    expect(step.speaking).toBe(false);
  });

  it("transitions to speaking on sound and reports speaking ticks", () => {
    const step = drive([
      [QUIET, 50],
      [LOUD, 100],
    ]);
    expect(step.state.phase).toBe("speaking");
    expect(step.speaking).toBe(true);
  });

  it("closes the utterance after trailing silence", () => {
    const step = drive([
      [LOUD, 50],
      [LOUD, 500],
      [QUIET, 600],
      [QUIET, 600 + CFG.trailingSilenceMs],
    ]);
    expect(step.action).toBe("utterance_end");
  });

  it("discards a blip shorter than the speech minimum", () => {
    const step = drive([
      [LOUD, 50],
      [QUIET, 150], // spoke for only 100ms
      [QUIET, 150 + CFG.trailingSilenceMs],
    ]);
    expect(step.action).toBe("discard");
  });

  it("resuming speech cancels the trailing silence", () => {
    let state = createVadState(0);
    for (const [rms, at] of [
      [LOUD, 50],
      [LOUD, 500],
      [QUIET, 600],
      [LOUD, 900],
    ] as Array<[number, number]>) {
      const step = stepVad(state, rms, at, CFG);
      state = step.state;
      expect(step.action).toBe("none");
    }
    expect(state.phase).toBe("speaking");
  });

  it("force-closes at the utterance cap and keeps real speech", () => {
    let state = createVadState(0);
    state = stepVad(state, LOUD, 100, CFG).state;
    const step = stepVad(state, LOUD, CFG.maxUtteranceMs + 200, CFG);
    expect(step.action).toBe("utterance_end");
  });

  it("force-close without speech discards", () => {
    const state = createVadState(0);
    const step = stepVad(state, QUIET, CFG.maxUtteranceMs + 200, CFG);
    expect(step.action).toBe("discard");
  });

  it("never mutates the input state", () => {
    const state = createVadState(0);
    const frozen = JSON.stringify(state);
    stepVad(state, LOUD, 100, CFG);
    expect(JSON.stringify(state)).toBe(frozen);
  });
});
