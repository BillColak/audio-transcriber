import OpenAI from 'openai';
import type { ChatMessage } from './types.js';

export const DEFAULT_CHAT_MODEL = 'gpt-5-mini';

/** Same ceiling as the summarizer — keeps a 20-hour recording from blowing past the model's context window. */
const MAX_INPUT_CHARACTERS = 400_000;

/** All Q&A pairs are persisted on the transcript, but only the most recent turns are replayed to the model. */
const MAX_HISTORY_MESSAGES = 20;

const instructions = [
  'You answer questions about a single transcript, using only the transcript text provided.',
  'If the answer is not in the transcript, say so plainly rather than guessing.',
  'The transcript is machine-generated and may contain mishearings; interpret intent charitably.',
  'Answer in the same language as the question when reasonable, otherwise match the transcript\'s own language.',
  'Keep answers concise unless the user asks for detail.',
].join('\n');

export class OpenAIChatAssistant {
  constructor(private readonly apiKey: string | undefined, private readonly model: string = DEFAULT_CHAT_MODEL) {}

  async ask(transcriptText: string, history: ChatMessage[], question: string): Promise<string> {
    if (!this.apiKey) throw new Error('OPENAI_API_KEY is not configured.');
    const text = transcriptText.trim();
    if (!text) throw new Error('There is no transcript text to chat about.');
    const client = new OpenAI({ apiKey: this.apiKey });
    // No `temperature` or `max_tokens`: the gpt-5 family rejects both on chat completions.
    const response = await client.chat.completions.create({
      model: this.model,
      messages: [
        { role: 'system', content: instructions },
        { role: 'user', content: `Transcript:\n\n${text.slice(0, MAX_INPUT_CHARACTERS)}` },
        ...history.slice(-MAX_HISTORY_MESSAGES).map((message) => ({ role: message.role, content: message.content })),
        { role: 'user', content: question },
      ],
    });
    const answer = response.choices[0]?.message?.content?.trim();
    if (!answer) throw new Error('OpenAI returned an empty answer.');
    return answer;
  }
}

export function humanizeChatError(error: unknown): string {
  const message = error instanceof Error ? error.message : 'Unknown chat error.';
  if (/api.?key|401|authentication/i.test(message)) return 'OpenAI rejected the API key. Check it in Settings.';
  return `The question could not be answered: ${message}`;
}
