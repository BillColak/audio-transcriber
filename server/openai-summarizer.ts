import OpenAI from 'openai';

export const DEFAULT_SUMMARY_MODEL = 'gpt-5.6-terra';

/**
 * Roughly 200k tokens — about fifteen hours of speech, and still inside the cheaper
 * short-context price tier. The model holds far more; this is a cost guard, not a capacity one.
 */
const MAX_INPUT_CHARACTERS = 800_000;

const instructions = [
  'You write detailed meeting minutes from raw transcripts, for someone who was not in the room.',
  'Use plain Markdown with exactly these sections, in order:',
  '## Overview — a short paragraph: what the meeting was about, who took part, and what came out of it.',
  '## Discussion — the substance, grouped under `###` headings by topic. Cover what was said, who said it where the transcript makes that clear, and why it mattered. Give enough detail that someone who missed the meeting follows the reasoning, not just the conclusion.',
  '## Decisions — what was agreed and the reasoning behind each. Write "None recorded." if there were none.',
  '## Action items — bullets as "Owner — task (deadline)". Use "Unassigned" when no owner is named.',
  '## Open questions — anything raised but left unresolved. Write "None recorded." if there were none.',
  'Be thorough. A two-hour conversation should not collapse into a handful of bullets.',
  'Write in everyday language, and spell out jargon or acronyms the first time they appear.',
  'Write in the transcript\'s own language.',
  // The transcriber has no speaker labels and mishears names and technical terms constantly, so
  // reconstruction from context is the job, not an optional extra.
  'The transcript is machine-generated from audio and will contain mishearings. Work out from the surrounding context what was actually meant and write that, rather than repeating a garbled phrase. Where a passage is genuinely unintelligible, say so plainly instead of guessing.',
  'Never invent details, names, numbers, or commitments the transcript does not support.',
].join('\n');

export class OpenAISummarizer {
  constructor(private readonly apiKey: string | undefined, private readonly model: string = DEFAULT_SUMMARY_MODEL) {}

  async summarize(transcript: string): Promise<string> {
    if (!this.apiKey) throw new Error('OPENAI_API_KEY is not configured.');
    const text = transcript.trim();
    if (!text) throw new Error('There is no transcript text to summarise.');
    const client = new OpenAI({ apiKey: this.apiKey });
    // No `temperature` or `max_tokens`: the gpt-5 family rejects both on chat completions.
    // Minutes are written once and kept, so buy accuracy with reasoning effort — the extra
    // latency is invisible next to the transcription that just ran.
    const response = await client.chat.completions.create({
      model: this.model,
      reasoning_effort: 'high',
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
