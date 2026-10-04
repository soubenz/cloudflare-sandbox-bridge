/**
 * Which Unix user a lab service runs as, and the command that makes it so.
 *
 * Every service is launched by the platform through the sandbox control plane,
 * which runs as root. Until this module existed every service therefore ran as
 * root, including the many whose entrypoint is a script under /workspace, a
 * directory the platform chowns to `learner`. A learner could edit such a
 * script and call `POST /sessions/:id/services/:name/restart` with their own
 * session token, and their code ran as root: able to read the staged grader
 * bundle (/run/opalix/checks-*), the private lab material in /opt/lab, and to
 * forge any result the platform trusts the container for.
 *
 * The rule, applied when a manifest does not say:
 *
 *   A service whose argv or cwd points into a path the learner can write
 *   runs as `learner`. Anything else runs as `root`, as before.
 *
 * Why argv OR cwd, not just "the entrypoint is a learner file": a root process
 * whose working directory the learner can write is one `python -m`, one
 * relative path or one config file looked up in `.` away from running a file
 * the learner put there (`python -m mcpgateway` puts the cwd first on
 * sys.path, so a /workspace/mcpgateway/ shadows the installed package). And a
 * path in argv is either code (`python3 /workspace/app.py`), a config file the
 * program trusts (which for most of these programs can name a plugin, a
 * callback module or a file to write), or a data directory; none of the three
 * is safe to hand a root process when the learner controls it.
 *
 * `user: root` in the manifest overrides the rule. It is for the few services
 * that cannot run unprivileged (Postgres, which drops to `postgres` itself via
 * runuser; LiteLLM with a database, whose Prisma engines are cached under
 * /root), must carry a comment in the manifest saying why, and is linted
 * (scripts/lint-labs.mjs, rule `service-user`): running learner code as root
 * is an error, reading a learner-writable path as root is a warning.
 */

export type ServiceUser = 'learner' | 'root';

export const SERVICE_USERS = ['learner', 'root'] as const;

/** The unprivileged account every lab image creates (`useradd -m -s /bin/bash learner`). */
export const LEARNER_ACCOUNT = { name: 'learner', home: '/home/learner' } as const;

/**
 * Top-level paths the learner's shell can write to in a lab container:
 * /workspace (chowned to learner by hydrate), the world-writable temp dirs,
 * and the learner's own home. Keep scripts/lint-labs.mjs's copy in step
 * (test/unit/service-user.test.ts asserts they match).
 */
export const LEARNER_WRITABLE_ROOTS = ['/workspace', '/tmp', '/var/tmp', '/dev/shm', '/home/learner'] as const;

/**
 * A learner-writable root as a path component, anywhere in a string: alone,
 * as an argument (`file:/workspace/x.yaml`, `--data=/tmp/x`,
 * `sqlite:////tmp/x.db`) or inside an `sh -c` script. Not when it is the tail
 * of a longer path (`/usr/tmp`, `/opt/x/workspace`).
 */
export const LEARNER_WRITABLE_PATH_RE = /(?<![\w.~-])\/(?:workspace|tmp|var\/tmp|dev\/shm|home\/learner)(?![\w.-])/;

export function mentionsLearnerWritablePath(value: string): boolean {
  return LEARNER_WRITABLE_PATH_RE.test(value);
}

/** The default user for a service whose manifest does not set one (see the rule above). */
export function defaultServiceUser(spec: { argv: readonly string[]; cwd: string }): ServiceUser {
  if (mentionsLearnerWritablePath(spec.cwd)) return 'learner';
  if (spec.argv.some(mentionsLearnerWritablePath)) return 'learner';
  return 'root';
}

/**
 * The user a stored spec launches as. parseManifest always fills `user` in, so
 * every session started after this field existed has it. A spec without one
 * was stored by a session that started before then and is still running (or
 * suspended); it keeps the identity it was started with, root, until it ends,
 * because flipping a live session's Postgres or LiteLLM to an unprivileged
 * user on its next restart would break it mid-lab.
 */
export function serviceUser(spec: { user?: ServiceUser }): ServiceUser {
  return spec.user ?? 'root';
}

/**
 * The privilege drop. setpriv (util-linux, Essential on every Debian and
 * Ubuntu base, at /usr/bin/setpriv on both jammy and bookworm, the same
 * package as the `runuser` the Postgres services already rely on) changes
 * uid, gid and supplementary groups and then execve()s the command in place:
 * same pid, same process group, no PAM session and no forked parent, so the
 * control plane's SIGTERM/SIGKILL, waitForExit, logs and port watch all see
 * the service itself, exactly as they did when it ran as root. `runuser`
 * would fork and wait instead, and a SIGKILL to it would orphan the service
 * still holding its port. Absolute path so the lookup never depends on PATH.
 */
export const SETPRIV = '/usr/bin/setpriv';

export const LEARNER_LAUNCH_PREFIX = [
  SETPRIV,
  `--reuid=${LEARNER_ACCOUNT.name}`,
  `--regid=${LEARNER_ACCOUNT.name}`,
  '--init-groups',
  '--',
] as const;

/**
 * setpriv leaves the environment exactly as it was, so a dropped service would
 * otherwise inherit root's HOME (/root, mode 0700): anything that writes a
 * cache or dotfile under ~ would fail. These are what a login as `learner`
 * would set; the session and service env are applied over them, so a
 * manifest can still choose its own.
 */
export const LEARNER_IDENTITY_ENV: Readonly<Record<string, string>> = {
  HOME: LEARNER_ACCOUNT.home,
  USER: LEARNER_ACCOUNT.name,
  LOGNAME: LEARNER_ACCOUNT.name,
};

export interface ServiceLaunch {
  user: ServiceUser;
  argv: string[];
  env: Record<string, string>;
}

/**
 * The exact argv and env a service is exec'd with. The spec's argv is passed
 * through untouched after the prefix (setpriv takes no shell, so an
 * `["sh", "-c", "..."]` service keeps its own quoting), and cwd is applied by
 * the control plane before setpriv runs, so it is not part of this.
 * Precedence of env: identity < session env < service env.
 */
export function buildServiceLaunch(
  spec: { argv: readonly string[]; env?: Record<string, string>; user?: ServiceUser },
  sessionEnv: Record<string, string>
): ServiceLaunch {
  const user = serviceUser(spec);
  if (user === 'root') {
    return { user, argv: [...spec.argv], env: { ...sessionEnv, ...spec.env } };
  }
  return {
    user,
    argv: [...LEARNER_LAUNCH_PREFIX, ...spec.argv],
    env: { ...LEARNER_IDENTITY_ENV, ...sessionEnv, ...spec.env },
  };
}
