import assert from "node:assert/strict";
import { beforeEach, mock, test } from "node:test";
import type { StreamRequest } from "../src/main/assistant";
import { LiveController, writeNotes, type LiveDeps } from "../src/main/live";
import type { AnswerEvent, SessionRecord, Settings } from "../src/shared/types";

/** A model call the test finishes by hand; it fails like the real ones when aborted. */
interface Call {
  req: StreamRequest;
  finish(text: string): void;
}

function setup(kind: SessionRecord["kind"] = "real") {
  const calls: Call[] = [];
  const events: AnswerEvent[] = [];
  const saves: number[] = [];
  const spoken: string[] = [];
  const record = {
    id: "s1", company: "", position: "", mode: "interview", kind, language: "English", model: "", resumeDocId: "", documentIds: [],
    instructions: "", saveTranscript: true, createdAt: 0, startedAt: null, endedAt: null, durationMs: 0, state: "ready",
    segments: [], answers: [], notes: "", feedback: "", chat: [], generating: false,
  } as SessionRecord;
  const deps = {
    provider: () => ({
      ready: () => true,
      notReadyMessage: "",
      describeError: (err: unknown) => String(err),
      stream: (req: StreamRequest) =>
        new Promise<string>((resolve, reject) => {
          calls.push({ req, finish: resolve });
          req.signal.addEventListener("abort", () => reject(new Error("aborted")));
        }),
    }),
    settings: () => ({ autoAnswer: true, liveEffort: "low", mockQuestions: 3 }) as Settings,
    docs: { get: () => undefined, text: () => "" },
    store: { save: (r: SessionRecord) => saves.push(r.segments.length) },
    transcriber: { flush: async () => {} },
    send: (channel: string, payload: unknown) => {
      if (channel === "answer") events.push(payload as AnswerEvent);
      if (channel === "speak") spoken.push(payload as string);
    },
    sessionsChanged: () => {},
    captureScreen: async () => "",
  } as unknown as LiveDeps;
  const live = new LiveController(deps);
  live.start(record);
  saves.length = 0;
  return { live, record, calls, events, saves, spoken };
}

/** Lets promise callbacks (aborts, finished streams) run. */
const settle = () => new Promise((r) => setImmediate(r));
const question = (c: Call) => /<question>\n([\s\S]*)\n<\/question>/.exec(c.req.prompt.text)?.[1];

beforeEach(() => {
  mock.timers.reset();
  mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1_000_000 });
});

test("a question is answered as soon as it is heard", () => {
  const { live, calls } = setup();
  live.onSegment("them", "Why did you leave your last job?");
  assert.equal(calls.length, 1);
});

test("a question split by a pause restarts with the whole utterance", async () => {
  const { live, calls, events } = setup();
  live.onSegment("them", "How would you design");
  mock.timers.tick(500);
  live.onSegment("them", "a rate limiter?");
  await settle();
  assert.equal(calls.length, 2);
  assert.equal(calls[0].req.signal.aborted, true);
  assert.equal(question(calls[1]), "How would you design a rate limiter?");
  // The first attempt is removed from the window, not shown as "Stopped."
  const first = events.filter((e) => e.id === 1 && e.done);
  assert.deepEqual(first.map((e) => [e.superseded, e.error]), [[true, undefined]]);
});

test("a later auto answer does not stop one that is streaming", async () => {
  const { live, calls } = setup();
  live.onSegment("them", "Why did you leave your last job?");
  mock.timers.tick(1000); // the utterance is over
  live.onSegment("them", "Do you have experience with Kubernetes?");
  await settle();
  assert.equal(calls.length, 2);
  assert.equal(calls[0].req.signal.aborted, false);
});

test("a message from the user replaces what is streaming, and Stop ends everything", async () => {
  const { live, calls, events } = setup();
  live.onSegment("them", "Why did you leave your last job?");
  void live.sendMessage("shorter please");
  await settle();
  assert.equal(calls[0].req.signal.aborted, true);
  assert.equal(events.find((e) => e.id === 1 && e.done)?.error, "Stopped.");
  live.cancel();
  assert.equal(calls[1].req.signal.aborted, true);
});

test("statements do not trigger an answer", () => {
  const { live, calls } = setup();
  live.onSegment("them", "Will do, thanks for that.");
  assert.equal(calls.length, 0);
});

test("the call is saved while it runs", async () => {
  const { live, record, calls, saves } = setup();
  live.onSegment("them", "Why did you leave your last job?");
  live.onSegment("them", "Take your time.");
  assert.deepEqual(saves, []);
  mock.timers.tick(2000);
  assert.deepEqual(saves, [2]); // one batched save holding both segments
  calls.at(-1)!.finish("Because...");
  await settle();
  mock.timers.tick(2000);
  assert.equal(saves.length, 2);
  assert.equal(record.answers.length, 1);
});

test("the transcript is kept in spoken order", () => {
  const { live, record } = setup();
  // My words ended first but arrive later: the caller is decoded first and
  // "me" segments are held for the echo check.
  live.onSegment("me", "I led the migration to Postgres last year.", Date.now() - 4000);
  live.onSegment("them", "Great, thanks for explaining.", Date.now());
  mock.timers.tick(1500);
  assert.deepEqual(record.segments.map((s) => s.speaker), ["me", "them"]);
});

test("words the mic picked up from the caller are dropped", () => {
  const { live, record } = setup();
  live.onSegment("them", "Tell me about the hardest bug you ever fixed in production.");
  live.onSegment("me", "tell me about the hardest bug you ever fixed in production");
  mock.timers.tick(1500);
  assert.deepEqual(record.segments.map((s) => s.speaker), ["them"]);
});

test("mock interview: the interviewer's own voice is not taken as the answer", async () => {
  const { live, record, calls, spoken } = setup("mock");
  live.windowReady();
  calls[0].finish("Thanks for joining. To start, tell me about a project you are proud of and what your part in it was.");
  await settle();
  assert.equal(spoken.length, 1);
  mock.timers.tick(10_000); // the voice takes ten seconds
  live.speakingDone();
  const done = Date.now();
  // The mic's copy of the last sentence is decoded just after the voice stops.
  live.onSegment("me", "and what your part in it was", done + 300, 2500);
  // The candidate's real answer starts afterwards.
  live.onSegment("me", "Sure, I rebuilt our billing pipeline.", done + 5000, 3000);
  mock.timers.tick(8000);
  assert.deepEqual(record.segments.map((s) => [s.speaker, s.text.slice(0, 4)]), [["them", "Than"], ["me", "Sure"]]);
});

test("notes are written with the notes model, or the session's when none is set", async () => {
  for (const [setting, expected] of [["strong-model", "strong-model"], ["", "session-model"]]) {
    const { live, record, calls } = setup();
    record.model = "session-model";
    live.onSegment("them", "We use Postgres and Redis for most things.");
    const ended = live.end();
    await settle(); // end() first flushes speech-to-text, then waits out the echo hold
    mock.timers.tick(2000);
    await ended;
    const deps = { provider: (live as any).deps.provider, notesModel: () => setting, docs: (live as any).deps.docs, store: { save: () => {}, get: () => record }, sessionsChanged: () => {} };
    const written = writeNotes(record, deps as any);
    await settle();
    assert.deepEqual(calls.map((c) => c.req.model), [expected, expected]); // notes and feedback
    calls.forEach((c) => c.finish("## Summary"));
    assert.equal(await written, null);
    assert.equal(record.notes, "## Summary");
  }
});
