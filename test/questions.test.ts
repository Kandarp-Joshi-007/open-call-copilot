import assert from "node:assert/strict";
import { test } from "node:test";
import { looksLikeQuestion } from "../src/main/questions";

const QUESTIONS = [
  "Why did you leave your last job?",
  "Why did you leave? Take your time.",
  "Tell me about a time you disagreed with your manager.",
  "So tell me about yourself.",
  "Walk me through your design",
  "Can you explain how a hash map works",
  "Do you have experience with Kubernetes",
  "Is there anything you would do differently",
  "What is your biggest weakness",
  "How would you scale this service",
  "How many users did it serve",
  "Design a rate limiter for our API.",
  "Write a function that reverses a linked list.",
  "Okay. Describe the hardest bug you fixed.",
  "I looked at your resume. Have you ever led a team",
];

const NOT_QUESTIONS = [
  "Will do, thanks for that.",
  "Can't wait to see it.",
  "When I joined, we had no tests at all.",
  "What I mean is that the team is small.",
  "Do note that the role is remote.",
  "Is what it is, I suppose.",
  "Share and enjoy, everyone.",
  "Design is a big part of this role.",
  "Write access is limited to admins.",
  "That makes sense. Right?",
  "Okay, great.",
  "Why?",
  "We use Postgres and Redis for most things.",
  "How we work is pretty informal.",
];

test("questions and prompts are detected", () => {
  for (const q of QUESTIONS) assert.equal(looksLikeQuestion(q), true, q);
});

test("statements are left alone", () => {
  for (const s of NOT_QUESTIONS) assert.equal(looksLikeQuestion(s), false, s);
});
