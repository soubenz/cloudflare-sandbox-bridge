import { z } from 'zod';
import catalogue from '../../packages/catalogue/voices.json';
import { NARRATOR_ID, SPEAKING_CAST_IDS } from './comic-kit';
import { VOICE_ID } from './learn';

/**
 * The voice cast of the motion comics (packages/catalogue/voices.json): which voice of a text-to-speech
 * model reads the storyteller's voiceovers (`narrator`) and which speaks each person's bubbles (`cast`, one
 * entry per person of the speaking cast, comic-kit SPEAKING_CAST_IDS; the learner is never voiced). `name`
 * is the voice's own name in that service (for people choosing or regenerating a line), `voice` its id,
 * which is stored with each clip and is part of the clip's key.
 *
 * `labs narrate --plan` reads it to list the lines to generate, and `labs narrate --from-dir` with a
 * manifest that names who speaks each clip uses it when the manifest gives no `voices` of its own.
 */

const voice = z.object({ name: z.string().min(1).max(60), voice: z.string().regex(VOICE_ID, 'a voice id: letters, digits and . _ : / - only') }).strict();

export const VoiceCastSchema = z
  .object({
    model: z.string().regex(/^\S{1,80}$/, 'a model id: 1 to 80 characters, no spaces'),
    narrator: voice,
    cast: z.record(z.string(), voice),
  })
  .strict()
  .superRefine((v, ctx) => {
    for (const id of Object.keys(v.cast)) {
      if (!SPEAKING_CAST_IDS.includes(id)) ctx.addIssue({ code: 'custom', path: ['cast', id], message: `${id} is not of the speaking cast (${SPEAKING_CAST_IDS.join(', ')})` });
    }
    for (const id of SPEAKING_CAST_IDS) {
      if (!(id in v.cast)) ctx.addIssue({ code: 'custom', path: ['cast'], message: `${id} has no voice` });
    }
    const ids = [v.narrator.voice, ...Object.values(v.cast).map((c) => c.voice)];
    if (new Set(ids).size !== ids.length) ctx.addIssue({ code: 'custom', message: 'two speakers share a voice: give everybody their own' });
  });
export type VoiceCast = z.infer<typeof VoiceCastSchema>;

/** packages/catalogue/voices.json, checked (a bad file fails at load, so the CLI never imports with a wrong voice). */
export const VOICE_CAST: VoiceCast = VoiceCastSchema.parse(catalogue);

/** Who speaks in which voice: `{ narrator: <id>, maren: <id>, ... }`. */
export function voicesOf(cast: VoiceCast = VOICE_CAST): Record<string, string> {
  const out: Record<string, string> = { [NARRATOR_ID]: cast.narrator.voice };
  for (const [id, c] of Object.entries(cast.cast)) out[id] = c.voice;
  return out;
}

/** The voice's own name (Mark, Helena, ...) for a speaker, when the voice cast has one. */
export function voiceNameOf(who: string, cast: VoiceCast = VOICE_CAST): string | undefined {
  return who === NARRATOR_ID ? cast.narrator.name : cast.cast[who]?.name;
}
