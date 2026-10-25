# Mynah

A real-time call assistant for Windows. Speech-to-text runs locally with NVIDIA Parakeet, and answers come from ChatGPT (on your own ChatGPT plan, no API key) or Claude (with an Anthropic API key).

## Features

- **Call Sessions:** create a session per call with company, role, mode (Interview or Regular call), language, AI model, resume, documents and instructions. Sessions are listed as Ready to Start, Live or Ended.
- **Live window:** an always-on-top panel showing live captions of the other side, answer cards when a question is detected (Auto Answer), a manual message box, and Answer / Screenshot buttons.
- **Screenshot:** sends a screenshot of a coding or technical problem and gets back an approach, complexity and code.
- **After the call:** AI Notes (summary, questions asked, key points, next steps), the full transcript, interview feedback with scores, and Ask AI about the call.
- **Mock Session:** an AI interviewer asks questions out loud (text-to-speech) and responds to your spoken answers.
- **Documents:** upload a resume, briefs or notes once and reuse them in any session.
- **Meeting detection:** offers to start a session when Zoom, Teams or a browser call starts using the microphone.

## Setup

Requires Windows 10/11 and Node.js 20+.

```
npm install
npm run models   # downloads Parakeet TDT 0.6B v3 int8 + Silero VAD (~490 MB) into ./models
npm start
```

Then open **Settings** and either click **Continue with ChatGPT** (uses your ChatGPT plan's limits) or switch to Claude and add an Anthropic API key. Use headphones so your mic does not pick up the other side.

Hotkeys during a session: `Ctrl+Alt+Enter` answer · `Ctrl+Alt+S` screenshot · `Ctrl+Alt+H` show/hide the live window.

## How it works

| Part | File |
|---|---|
| Speech-to-text: Silero VAD cuts audio at pauses, Parakeet decodes each segment | `src/main/stt.ts` |
| Live session: captions, question detection, answers, mock interviewer | `src/main/live.ts` |
| Prompts and context (resume, documents, instructions) | `src/main/assistant.ts` |
| ChatGPT provider (Responses API) and Sign in with ChatGPT (OAuth + PKCE) | `src/main/providers/chatgpt.ts`, `src/main/chatgpt-auth.ts` |
| Claude provider (Anthropic SDK, prompt caching) | `src/main/providers/claude.ts` |
| Sessions and documents storage | `src/main/store.ts` |
| Windows, IPC, hotkeys, meeting detection | `src/main/main.ts`, `src/main/meetings.ts` |
| Dashboard and live window UI, audio capture | `src/renderer/` |

Call audio is captured as system loopback audio and your voice from the microphone, both resampled to 16 kHz. Sessions, documents, settings and the encrypted sign-in are stored in `%APPDATA%\mynah`.

## Responsible use

The live window is visible on screen share, by design. Use Mynah where AI assistance is allowed: practice, mock interviews, sales and client calls, meetings, or interviews where you have permission. Many employers and exam providers do not allow live AI help, so check the rules first.

## License

MIT, see [LICENSE](LICENSE). The speech models downloaded by `npm run models` keep their own licenses (listed below).

## Credits

- [sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx) (Apache-2.0) for on-device speech recognition and voice activity detection
- [NVIDIA Parakeet TDT 0.6B v3](https://huggingface.co/nvidia/parakeet-tdt-0.6b-v3) (CC-BY-4.0) speech model
- [Silero VAD](https://github.com/snakers4/silero-vad) (MIT)
