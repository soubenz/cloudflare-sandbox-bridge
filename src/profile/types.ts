/** Shared shapes of the profile feature. Pure data: nothing here touches D1, R2 or the clock. */

export type Difficulty = 'intro' | 'core' | 'advanced';

/** The slice of a catalogue entry (`LabIndexEntry`) the profile reads. */
export interface CatalogueLab {
  slug: string;
  title: string;
  path?: string | undefined;
  module?: number | undefined;
  order?: number | undefined;
  difficulty?: Difficulty | undefined;
  estimated_minutes?: number | undefined;
  prerequisites?: string[] | undefined;
  /** Whether the free plan may start the lab; missing is 'pro', as in the manifest. */
  tier?: 'free' | 'pro' | undefined;
  archived?: boolean | undefined;
}

/** One finished check run of the learner (a `check_runs` row). `score` is 0-1. */
export interface RunFact {
  run_id: string;
  session_id: string;
  lab_slug: string;
  started_at: number;
  finished_at: number | null;
  score: number;
  /** True when the run passed every check of the lab. */
  passed_all: boolean;
}

/** The session facts a run needs: when it began and how many hints had unlocked. */
export interface SessionFact {
  id: string;
  lab_slug: string;
  created_at: number;
  started_at: number | null;
  hints_delivered: number;
}

/** An award row already stored for the learner. */
export interface StoredAward {
  award_id: string;
  earned_at: number;
  session_id: string | null;
}

/** How the onboarding quiz placed the learner in an area: a starting point only, never part of a score. */
export type StartingLevel = 'new' | 'ok' | 'strong';

/** Everything the profile is computed from. Built by `buildFacts` from D1, or by hand in a test. */
export interface ProfileFacts {
  user_id: string;
  /** Epoch ms; decides whether a streak is still alive. */
  now: number;
  runs: RunFact[];
  sessions: SessionFact[];
  earned: StoredAward[];
  /**
   * The quiz level per skill: the one stored with the learner's path inputs (D1), or, when there is none, what
   * the console sent in `?starting=`. Echoed as `starting_level`; a 'strong' skill also leaves the labs its
   * path skips out of its score.
   */
  starting_levels?: Record<string, StartingLevel> | undefined;
  /** The learner's plan; missing reads as 'pro' (every lab startable). */
  plan?: 'free' | 'pro' | undefined;
  /** The steps of the learner's stored personal path, when there is one: the first place the next lab comes from. */
  path_steps?: ReadonlyArray<{ slug: string; status: string }> | null | undefined;
}

export type AwardTier = 'bronze' | 'silver' | 'gold';

export interface EarnedAward {
  id: string;
  title: string;
  description: string;
  icon: string;
  tier: AwardTier;
  earned_at: number;
  session_id: string | null;
}

export interface LockedAward {
  id: string;
  title: string;
  description: string;
  icon: string;
  tier: AwardTier;
  progress: { have: number; need: number };
}

export type SkillLevel = 'Not started' | 'Foundations' | 'Practitioner' | 'Proficient' | 'Expert';

export interface Skill {
  area: string;
  title: string;
  score: number;
  level: SkillLevel;
  evaluation: string;
  labs_done: number;
  labs_total: number;
  next_lab: { slug: string; title: string } | null;
  /** From the onboarding quiz when the caller passes it; never scored. */
  starting_level: StartingLevel | null;
}

export interface XpLevel {
  n: number;
  title: string;
  xp_into: number;
  /** Size of this level's band; 0 at the top level. */
  xp_needed: number;
}

export interface Streak {
  days: number;
  best: number;
  /** UTC calendar day (YYYY-MM-DD) of the latest completed lab or passing run, or null. */
  last_active: string | null;
}

/** The one lab to do next (src/path/next.ts), with where it sits so the console can mark its module. */
export interface NextLabRef {
  slug: string;
  title: string;
  skill: string | null;
  path: string | null;
  module: number | null;
}

export interface Profile {
  user_id: string;
  xp: number;
  level: XpLevel;
  streak: Streak;
  skills: Skill[];
  awards: { earned: EarnedAward[]; locked: LockedAward[] };
  overall: { score: number; level: SkillLevel; evaluation: string };
  /** The next lab overall: the learner's path's next step, else the first startable lab in catalogue order. */
  next_lab: NextLabRef | null;
  updated_at: number;
}

export interface CompactProfile {
  user_id: string;
  overall: Profile['overall'];
  level: XpLevel;
  xp: number;
  streak: Streak;
  top_skills: Array<Pick<Skill, 'area' | 'title' | 'score' | 'level'>>;
  recent_awards: EarnedAward[];
  next_lab: NextLabRef | null;
  updated_at: number;
}
