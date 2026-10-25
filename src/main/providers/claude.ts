import Anthropic from "@anthropic-ai/sdk";
import type { ModelOption } from "../../shared/types";
import type { LlmProvider, Prompt, StreamRequest } from "../assistant";

export const CLAUDE_MODELS: ModelOption[] = [
  { id: "claude-opus-5-5", name: "Claude Opus 5.5 (best answers)" },
  { id: "claude-sonnet-5-5", name: "Claude Sonnet 5.5 (faster)" },
  { id: "claude-haiku-5-5", name: "Claude Haiku 5.5 (fastest)" },
];

export class ClaudeProvider implements LlmProvider {
  readonly notReadyMessage = "Add your Anthropic API key in Settings first.";
  private client: Anthropic | null;

  constructor(
    private apiKey: string,
    private model: string,
  ) {
    // Without a key here the SDK falls back to ANTHROPIC_API_KEY.
    this.client = this.ready() ? (apiKey ? new Anthropic({ apiKey }) : new Anthropic()) : null;
  }

  ready(): boolean {
    return Boolean(this.apiKey || process.env.ANTHROPIC_API_KEY);
  }

  async stream(req: StreamRequest): Promise<string> {
    if (!this.client) throw new Error(this.notReadyMessage);
    // A session created under ChatGPT keeps a GPT model id; fall back to the default here.
    const model = req.model?.startsWith("claude-") ? req.model : this.model;
    // Server-side refusal fallback is not offered for Haiku.
    const fallback = model.startsWith("claude-haiku")
      ? {}
      : { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const };

    const history: Anthropic.Beta.BetaMessageParam[] = (req.history ?? []).map((m) => ({ role: m.role, content: m.text }));
    const stream = this.client.beta.messages.stream(
      {
        model,
        max_tokens: req.maxTokens,
        output_config: { effort: req.effort },
        system: [
          { type: "text", text: req.system },
          { type: "text", text: req.context, cache_control: { type: "ephemeral" } },
        ],
        messages: [...history, { role: "user", content: toContent(req.prompt) }],
        ...fallback,
      },
      { signal: req.signal },
    );

    for await (const event of stream) {
      if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
        req.onText?.(event.delta.text);
      }
    }

    const message = await stream.finalMessage();
    if (message.stop_reason === "refusal") {
      throw new Error("Claude declined to answer this request.");
    }
    return message.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("");
  }

  describeError(err: unknown): string {
    if (err instanceof Anthropic.AuthenticationError) return "Invalid Anthropic API key. Check it in Settings.";
    if (err instanceof Anthropic.PermissionDeniedError) return "This API key cannot use the selected model.";
    if (err instanceof Anthropic.NotFoundError) return "Model not found. Pick another model in Settings.";
    if (err instanceof Anthropic.RateLimitError) return "Rate limited by the API. Try again in a moment.";
    if (err instanceof Anthropic.BadRequestError) return `Request rejected: ${err.message}`;
    if (err instanceof Anthropic.APIConnectionError) return "Cannot reach the Claude API. Check your internet connection.";
    if (err instanceof Anthropic.APIError) return `API error ${err.status}: ${err.message}`;
    return (err as Error)?.message ?? String(err);
  }
}

function toContent(prompt: Prompt): Anthropic.Beta.BetaContentBlockParam[] {
  const blocks: Anthropic.Beta.BetaContentBlockParam[] = [];
  if (prompt.imageJpegBase64) {
    blocks.push({ type: "image", source: { type: "base64", media_type: "image/jpeg", data: prompt.imageJpegBase64 } });
  }
  blocks.push({ type: "text", text: prompt.text });
  return blocks;
}
