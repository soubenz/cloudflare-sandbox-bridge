import { z } from 'zod';
import library from '../../packages/catalogue/clips.json';

/**
 * The clip library: short generated animations (a video clip, or a still image) that a motion comic's
 * `scene: clip` panel plays under its bubbles, caption, sound effect and screen lines. A clip is made
 * once (by an AI video tool, say) and reused by many labs, so the comic player is the "video editor":
 * every word on a clip panel is drawn over it by the console, and a clip itself carries no text.
 *
 * Clips live in packages/catalogue/clips.json; their files in dashboard/public/media/clips/, which the
 * console serves as static assets at /media/clips/<file> (docs/learning-content.md, "The clip scene").
 */

const id = z.string().regex(/^[a-z][a-z0-9-]{0,39}$/, 'lowercase letters, digits and hyphens');
const text = (max: number) =>
  z
    .string()
    .min(1)
    .max(max)
    .refine((s) => !/[<>]/.test(s) && !s.includes('\n'), 'plain single-line text, no markup');

/** The extensions a clip's file may have, by kind; a poster is always an image. */
export const VIDEO_EXTENSIONS = ['mp4', 'webm'] as const;
export const IMAGE_EXTENSIONS = ['webp', 'png', 'jpg', 'jpeg', 'avif'] as const;
/** Where a clip's files are served from (dashboard/public/media/clips/ on disk). */
export const CLIP_DIR = '/media/clips/';
/** A clip file's path as the console serves it: /media/clips/<file>, a plain name with one of `exts`. */
export const clipPath = (exts: readonly string[]) =>
  new RegExp(`^/media/clips/[a-z0-9][a-z0-9._-]{0,99}\\.(${exts.join('|')})$`);

const src = (exts: readonly string[], what: string) =>
  z.string().regex(clipPath(exts), `${what}: /media/clips/<file> with lowercase letters, digits, dots, hyphens or underscores, ending .${exts.join(', .')}`);

export const ClipSchema = z
  .object({
    id,
    kind: z.enum(['video', 'image']),
    /** The clip's file, as served: /media/clips/<file>. */
    src: z.string(),
    /** A still shown before a video has loaded, if it cannot play, and under reduced motion. */
    poster: src(IMAGE_EXTENSIONS, 'a poster').optional(),
    /** What the clip shows, in words: the transcript reads it ("Read as text"). */
    alt: text(240),
    /** How long the clip is, in seconds: a hint until the video's own length is known. */
    seconds: z.number().positive().max(120).optional(),
    /** A video loops while its panel is on screen; without `loop` it rests on its last frame when it ends. */
    loop: z.literal(true).optional(),
  })
  .strict()
  .superRefine((c, ctx) => {
    const exts = c.kind === 'video' ? VIDEO_EXTENSIONS : IMAGE_EXTENSIONS;
    if (!clipPath(exts).test(c.src)) {
      ctx.addIssue({ code: 'custom', path: ['src'], message: `a ${c.kind} clip's src is /media/clips/<file> ending .${exts.join(', .')}` });
    }
    if (c.kind === 'image' && c.loop) ctx.addIssue({ code: 'custom', path: ['loop'], message: 'only a video loops' });
  });
export type Clip = z.infer<typeof ClipSchema>;

export const ClipLibrarySchema = z.object({ clips: z.array(ClipSchema).max(200) }).strict();

export function parseClipLibrary(raw: unknown): Clip[] {
  const parsed = ClipLibrarySchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error('Invalid clip library: ' + parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; '));
  }
  const ids = parsed.data.clips.map((c) => c.id);
  if (new Set(ids).size !== ids.length) throw new Error('Invalid clip library: two clips share an id');
  return parsed.data.clips;
}

/** Every clip in the shared library. */
export const CLIPS: readonly Clip[] = parseClipLibrary(library);
export const KNOWN_CLIPS: ReadonlySet<string> = new Set(CLIPS.map((c) => c.id));
