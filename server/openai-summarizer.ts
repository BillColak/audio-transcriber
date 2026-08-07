import OpenAI from 'openai';

export const DEFAULT_SUMMARY_MODEL = 'gpt-5-mini';

/** Keeps a 20-hour recording from blowing past the model's context window. */
const MAX_INPUT_CHARACTERS = 400_000;

const instructions = [
  'You write meeting minutes from raw transcripts.',
  'Produce concise, skimmable notes in plain Markdown using exactly these sections, in order:',
  '## Summary — two or three sentences on what the discussion covered.',
  '## Key points — bullets of the substantive points raised.',
  '## Decisions — bullets of what was agreed. Write "None recorded." if there were none.',
  '## Action items — bullets as "Owner — task (deadline)". Use "Unassigned" when no owner is named.',
  'Write in the transcript\'s own language. Never invent details that are not in the transcript.',
  'The transcript is machine-generated and may contain mishearings; summarise the intent, do not quote errors.',
].join('\n');


export class OpenAISummarizer {
  constructor(private readonly apiKey: string | undefined, private readonly model: string = DEFAULT_SUMMARY_MODEL) {}

  async summarize(transcript: string): Promise<string> {
    if (!this.apiKey) throw new Error('OPENAI_API_KEY is not configured.');
    const text = transcript.trim();
    if (!text) throw new Error('There is no transcript text to summarise.');
    const client = new OpenAI({ apiKey: this.apiKey });
    // No `temperature` or `max_tokens`: the gpt-5 family rejects both on chat completions.
    const response = await client.chat.completions.create({
      model: this.model,
      messages: [
        { role: 'system', content: instructions },
        { role: 'user', content: text.slice(0, MAX_INPUT_CHARACTERS) },
      ],
    });
    const summary = response.choices[0]?.message?.content?.trim();
    if (!summary) throw new Error('OpenAI returned an empty summary.');
    return summary;
  }
}
