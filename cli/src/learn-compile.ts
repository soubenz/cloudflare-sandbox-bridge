import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { LearnBundleSchema, checkLearnBundle, type LearnAudio, type LearnBundle } from '../../src/labs/learn';
import { ComicSchema, checkComic, type Comic } from '../../src/labs/comic';

/** Splits `---\nyaml\n---\nbody`; a file with no front matter has empty data. */
export function splitFrontMatter(text: string): { data: Record<string, unknown>; body: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  if (!m) return { data: {}, body: text.trim() };
  const data = parseYaml(m[1] ?? '');
  return { data: data && typeof data === 'object' ? (data as Record<string, unknown>) : {}, body: (m[2] ?? '').trim() };
}

export interface LearnCompileResult {
  bundle?: LearnBundle;
  problems: string[];
}

/**
 * Compiles `<labDir>/learn/` into a LearnBundle, or returns null when the lab
 * has no such folder. Never throws on bad content: every problem is returned
 * so an author sees them all at once.
 *
 *   learn/story.md               front matter: title, minutes; body: the case file
 *   learn/comic.yaml             optional motion comic of the story: title, panels (docs/learning-content.md)
 *   learn/audio.json + audio/    optional narration of the comic, written by `labs narrate` (clips are learn/audio/<key>.mp3)
 *   learn/concepts/<id>.md       front matter: id (must equal the file name), title, minutes, recap; body: the lesson
 *   learn/quiz.yaml              questions: [ ... ]
 *   learn/questions.yaml         answers_file, fields: [ ... ]   (explore labs)
 *   learn/closing.md             optional closing story, front matter as story.md
 *   learn/closing.yaml           its comic, the shape of comic.yaml (needs closing.md)
 *   learn/closing-audio.json     its narration, written by `labs narrate` (clips share learn/audio/)
 *   learn/games.yaml             games: [ ... ]   (played after the closing; docs/learning-content.md)
 */
export function compileLearnDir(labDir: string): LearnCompileResult | null {
  const dir = join(labDir, 'learn');
  if (!existsSync(dir)) return null;
  const problems: string[] = [];
  const read = (rel: string): string | null => {
    const p = join(dir, rel);
    return existsSync(p) ? readFileSync(p, 'utf8') : null;
  };

  let story: unknown;
  const storyText = read('story.md');
  if (storyText !== null) {
    const { data, body } = splitFrontMatter(storyText);
    story = { title: data.title, minutes: data.minutes, body };
  }

  const concepts: unknown[] = [];
  const conceptsDir = join(dir, 'concepts');
  if (existsSync(conceptsDir)) {
    // Lessons play in file-name order unless a lesson says `order: <n>` in its front matter
    // (lower first, default 100). The lesson that explains what the lab's subject *is* sets
    // `order: 1`, so it comes before the ones that assume you know.
    const loaded = readdirSync(conceptsDir)
      .filter((f) => f.endsWith('.md'))
      .sort()
      .map((file) => ({ file, ...splitFrontMatter(readFileSync(join(conceptsDir, file), 'utf8')) }));
    const orderOf = (d: Record<string, unknown>) => (typeof d.order === 'number' && Number.isFinite(d.order) ? d.order : 100);
    loaded.sort((a, b) => orderOf(a.data) - orderOf(b.data)); // stable: ties keep file-name order
    for (const { file, data, body } of loaded) {
      const stem = file.slice(0, -3);
      if (data.id !== stem) problems.push(`concepts/${file}: front matter id "${String(data.id)}" must equal the file name "${stem}"`);
      concepts.push({ id: data.id, title: data.title, minutes: data.minutes, recap: data.recap, body });
    }
  }

  let questions: unknown[] = [];
  const quizText = read('quiz.yaml');
  if (quizText !== null) {
    try {
      const y = parseYaml(quizText) as { questions?: unknown[] } | null;
      questions = Array.isArray(y?.questions) ? y!.questions! : [];
      if (!Array.isArray(y?.questions)) problems.push('quiz.yaml: expected a top-level `questions:` list');
    } catch (e) {
      problems.push(`quiz.yaml: not valid YAML (${(e as Error).message})`);
    }
  }

  let comic: unknown;
  const comicText = read('comic.yaml');
  if (comicText !== null) {
    try {
      comic = parseYaml(comicText);
    } catch (e) {
      problems.push(`comic.yaml: not valid YAML (${(e as Error).message})`);
    }
  }

  let audio: unknown;
  const audioText = read('audio.json');
  if (audioText !== null) {
    try {
      audio = JSON.parse(audioText);
    } catch (e) {
      problems.push(`audio.json: not valid JSON (${(e as Error).message})`);
    }
  }

  // The closing: a second story and comic, read like the opener's.
  let closing: Record<string, unknown> | undefined;
  const closingText = read('closing.md');
  const closingComicText = read('closing.yaml');
  const closingAudioText = read('closing-audio.json');
  if (closingText !== null || closingComicText !== null || closingAudioText !== null) {
    const c: Record<string, unknown> = {};
    if (closingText !== null) {
      const { data, body } = splitFrontMatter(closingText);
      c.story = { title: data.title, minutes: data.minutes, body };
    }
    if (closingComicText !== null) {
      try {
        c.comic = parseYaml(closingComicText);
      } catch (e) {
        problems.push(`closing.yaml: not valid YAML (${(e as Error).message})`);
      }
    }
    if (closingAudioText !== null) {
      try {
        c.audio = JSON.parse(closingAudioText);
      } catch (e) {
        problems.push(`closing-audio.json: not valid JSON (${(e as Error).message})`);
      }
    }
    if (closingComicText === null) {
      if (closingText !== null) problems.push('learn/closing.md is the text of a closing comic, but there is no closing.yaml');
      if (closingAudioText !== null) problems.push('learn/closing-audio.json narrates the closing comic, but there is no closing.yaml');
    } else if (closingText === null) {
      problems.push('closing.yaml needs learn/closing.md too: the text story is what screen readers, skipped comics and old consoles show');
    } else {
      closing = c;
    }
  }

  let games: unknown[] = [];
  const gamesText = read('games.yaml');
  if (gamesText !== null) {
    try {
      const y = parseYaml(gamesText) as { games?: unknown[] } | null;
      games = Array.isArray(y?.games) ? y!.games! : [];
      if (!Array.isArray(y?.games)) problems.push('games.yaml: expected a top-level `games:` list');
    } catch (e) {
      problems.push(`games.yaml: not valid YAML (${(e as Error).message})`);
    }
  }

  let answersFile: string | undefined;
  let fields: unknown[] = [];
  const qText = read('questions.yaml');
  if (qText !== null) {
    try {
      const y = parseYaml(qText) as { answers_file?: string; fields?: unknown[] } | null;
      answersFile = y?.answers_file;
      fields = Array.isArray(y?.fields) ? y!.fields! : [];
      if (!Array.isArray(y?.fields)) problems.push('questions.yaml: expected a top-level `fields:` list');
    } catch (e) {
      problems.push(`questions.yaml: not valid YAML (${(e as Error).message})`);
    }
  }

  const parsed = LearnBundleSchema.safeParse({
    version: 1,
    story,
    ...(comic !== undefined ? { comic } : {}),
    ...(audio !== undefined ? { audio } : {}),
    concepts,
    questions,
    ...(answersFile !== undefined ? { answers_file: answersFile } : {}),
    fields,
    ...(closing !== undefined ? { closing } : {}),
    games,
  });
  if (!parsed.success) {
    for (const i of parsed.error.issues) problems.push(`${i.path.join('.') || '(root)'}: ${i.message}`);
    return { problems };
  }
  problems.push(...checkLearnBundle(parsed.data));

  // Every clip the narration names must be on disk, as long as the index says; the closing's clips share learn/audio/.
  const indexes: [string, LearnAudio | undefined][] = [
    ['audio.json', parsed.data.audio],
    ['closing-audio.json', parsed.data.closing?.audio],
  ];
  for (const [name, audio] of indexes) {
    for (const [key, clip] of Object.entries(audio?.clips ?? {})) {
      const file = join(dir, 'audio', `${key}.mp3`);
      if (!existsSync(file)) problems.push(`${name} names clip ${key}, but learn/audio/${key}.mp3 does not exist; run \`labs narrate\``);
      else if (statSync(file).size !== clip.bytes) problems.push(`learn/audio/${key}.mp3 is ${statSync(file).size} bytes but ${name} says ${clip.bytes}; run \`labs narrate\``);
    }
  }

  // The console writes the learner's answers into the file the lab's grader
  // already reads, so the fields must match that file's keys exactly.
  if (parsed.data.fields.length > 0) {
    const answersPath = join(labDir, 'workspace', parsed.data.answers_file);
    if (!existsSync(answersPath)) {
      problems.push(`questions.yaml: workspace/${parsed.data.answers_file} does not exist, so there is nothing for the fields to fill`);
    } else {
      try {
        const template = JSON.parse(readFileSync(answersPath, 'utf8')) as Record<string, unknown>;
        const want = new Set(Object.keys(template));
        const have = new Set(parsed.data.fields.map((f) => f.key));
        for (const k of want) if (!have.has(k)) problems.push(`questions.yaml: workspace/${parsed.data.answers_file} has key "${k}" but no field asks for it`);
        for (const k of have) if (!want.has(k)) problems.push(`questions.yaml: field "${k}" is not a key of workspace/${parsed.data.answers_file}`);
      } catch {
        problems.push(`workspace/${parsed.data.answers_file} is not valid JSON`);
      }
    }
  }

  return problems.length > 0 ? { problems } : { bundle: parsed.data, problems: [] };
}

/**
 * Just the comic of `<labDir>/learn/comic.yaml` (or `closing.yaml`), validated like the full compile does (schema and
 * checkComic), for `labs narrate`: narrating must work while the existing narration is stale.
 * `comic` is absent when there is no file or it has problems.
 */
export function readComic(labDir: string, name: 'comic.yaml' | 'closing.yaml' = 'comic.yaml'): { comic?: Comic; problems: string[] } {
  const file = join(labDir, 'learn', name);
  if (!existsSync(file)) return { problems: [`${labDir} has no learn/${name} to narrate`] };
  let raw: unknown;
  try {
    raw = parseYaml(readFileSync(file, 'utf8'));
  } catch (e) {
    return { problems: [`${name}: not valid YAML (${(e as Error).message})`] };
  }
  const parsed = ComicSchema.safeParse(raw);
  const prefix = name === 'comic.yaml' ? 'comic' : 'closing.comic';
  if (!parsed.success) return { problems: parsed.error.issues.map((i) => `${prefix}.${i.path.join('.') || '(root)'}: ${i.message}`) };
  const problems = checkComic(parsed.data);
  return problems.length > 0 ? { problems } : { comic: parsed.data, problems: [] };
}
