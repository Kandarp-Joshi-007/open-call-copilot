import OpenAI from "openai";
import type { ModelOption } from "../../shared/types";
import type { LlmProvider, StreamRequest } from "../assistant";
import { ChatGPTAuth, RESOURCE, SignInError } from "../chatgpt-auth";

/**
 * Runs on the user's ChatGPT plan through the public Responses API, with the
 * OAuth access token from "Sign in with ChatGPT" as the bearer credential.
 * The preview requires store:false and stream:true, and rejects
 * max_output_tokens / temperature / system-role items, so none are sent.
 */
export class ChatGPTProvider implements LlmProvider {
  readonly notReadyMessage = "Sign in with ChatGPT in Settings first.";

  constructor(
    private auth: ChatGPTAuth,
    private model: string,
  ) {}

  ready(): boolean {
    return this.auth.account !== null;
  }

  async stream(req: StreamRequest): Promise<string> {
    try {
      return await this.attempt(req, false);
    } catch (err) {
      // A token can be revoked or expire early: refresh once and retry.
      if (err instanceof OpenAI.AuthenticationError && !req.signal.aborted) return this.attempt(req, true);
      throw err;
    }
  }

  private async attempt(req: StreamRequest, forceRefresh: boolean): Promise<string> {
    const client = new OpenAI({ apiKey: await this.auth.accessToken(forceRefresh), baseURL: RESOURCE, maxRetries: 0 });
    const content: OpenAI.Responses.ResponseInputContent[] = [{ type: "input_text", text: req.prompt.text }];
    if (req.prompt.imageJpegBase64) {
      content.unshift({ type: "input_image", image_url: `data:image/jpeg;base64,${req.prompt.imageJpegBase64}`, detail: "high" });
    }
    // The preview has no stored conversations, so earlier turns are resent every time.
    const history: OpenAI.Responses.ResponseInputItem[] = (req.history ?? []).map((m) => ({ role: m.role, content: m.text }));

    const stream = await client.responses.create(
      {
        // A session created under Claude keeps a Claude model id; use the default instead.
        model: req.model && !req.model.startsWith("claude-") ? req.model : this.model,
        // Stable text first so OpenAI's automatic prefix caching can reuse it.
        instructions: `${req.system}\n\n<context>\n${req.context}\n</context>`,
        input: [...history, { role: "user", content }],
        reasoning: { effort: req.effort },
        store: false,
        stream: true,
      },
      { signal: req.signal },
    );

    let text = "";
    for await (const event of stream) {
      switch (event.type) {
        case "response.output_text.delta":
          text += event.delta;
          req.onText?.(event.delta);
          break;
        case "response.failed":
          throw new PlanError(event.response.error?.code ?? "unknown_error", event.response.error?.message);
        case "response.incomplete":
          throw new PlanError("incomplete", event.response.incomplete_details?.reason ?? undefined);
        case "response.completed":
          return text;
      }
    }
    throw new Error("The ChatGPT response stream ended early. Try again.");
  }

  describeError(err: unknown): string {
    if (err instanceof SignInError) return err.message;
    if (err instanceof PlanError) {
      if (err.code === "subscription_sharing_usage_limit_exceeded") {
        return "You have reached your ChatGPT plan's usage limit for now. See chatgpt.com/settings/usage.";
      }
      if (err.code === "subscription_sharing_usage_unavailable") {
        return "ChatGPT plan usage is not available for this account right now. Check chatgpt.com/settings/usage.";
      }
      return `ChatGPT could not finish the answer (${err.code}${err.detail ? `: ${err.detail}` : ""}).`;
    }
    if (err instanceof OpenAI.AuthenticationError) return "ChatGPT rejected the sign-in. Sign in again in Settings.";
    if (err instanceof OpenAI.NotFoundError) return "That model is not available on your ChatGPT plan. Pick another in Settings.";
    if (err instanceof OpenAI.RateLimitError) return "ChatGPT is rate limiting requests. Try again in a moment.";
    if (err instanceof OpenAI.BadRequestError) return `ChatGPT rejected the request: ${err.message}`;
    if (err instanceof OpenAI.APIConnectionError) return "Cannot reach ChatGPT. Check your internet connection.";
    if (err instanceof OpenAI.APIError) return `ChatGPT error ${err.status}: ${err.message}`;
    return (err as Error)?.message ?? String(err);
  }
}

class PlanError extends Error {
  constructor(
    readonly code: string,
    readonly detail?: string,
  ) {
    super(`${code}${detail ? `: ${detail}` : ""}`);
  }
}

/** Models the signed-in ChatGPT account can use, in the server's order. */
export async function listChatGPTModels(auth: ChatGPTAuth): Promise<ModelOption[]> {
  const res = await fetch(`${RESOURCE}/models`, { headers: { authorization: `Bearer ${await auth.accessToken()}` } });
  if (!res.ok) throw new Error(`Could not load ChatGPT models (HTTP ${res.status}).`);
  const body = (await res.json()) as { models?: { slug: string; display_name?: string; visibility?: string }[] };
  return (body.models ?? [])
    .filter((m) => m.visibility === "list")
    .map((m) => ({ id: m.slug, name: m.display_name ?? m.slug }));
}

/**
 * Default for live answers. Measured on 2026-10-24 with the same question:
 * GPT-5.6-Luna first words 1.8 s, GPT-6.1-Sol 2.8 s, GPT-6-Luna 6.6 s.
 */
export function pickFastModel(models: ModelOption[]): string {
  return (models.find((m) => m.id === "gpt-5.6-luna") ?? models.find((m) => /luna/i.test(m.id)) ?? models[0])?.id ?? "";
}
