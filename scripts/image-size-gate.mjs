#!/usr/bin/env node
// Image size gate: fails when a container image's uncompressed size exceeds
// 85% of the disk its instance type provides. Cloudflare rejects instances
// whose disk is smaller than the unpacked image (ImagePullError), and the
// failure only shows up after deploy. See wrangler.jsonc's GatewayLab comment.
//
// Run after `wrangler deploy --dry-run`, which builds the images locally.
// IMAGE_SIZE_OVERRIDE_<CLASS>=<bytes> replaces the `docker image inspect`
// lookup (for tests), e.g. IMAGE_SIZE_OVERRIDE_GATEWAYLAB=15000000000.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'jsonc-parser';

const THRESHOLD = 0.85;
const PRESET_DISK_MB = {
  lite: 2000,
  basic: 4000,
  'standard-1': 8000,
  'standard-2': 12000,
  'standard-3': 16000,
  'standard-4': 20000,
};

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const config = parse(readFileSync(join(root, 'wrangler.jsonc'), 'utf8'));
const workerName = config.name;

function diskMb(instanceType) {
  if (typeof instanceType === 'string') {
    const mb = PRESET_DISK_MB[instanceType];
    if (!mb) throw new Error(`unknown instance_type preset "${instanceType}"`);
    return mb;
  }
  if (instanceType && typeof instanceType.disk_mb === 'number') return instanceType.disk_mb;
  // Wrangler's default instance type when none is given is "lite".
  if (instanceType === undefined) return PRESET_DISK_MB.lite;
  throw new Error(`cannot determine disk_mb from ${JSON.stringify(instanceType)}`);
}

// Wrangler names the image repository `<worker>-<lowercase class>`. Its
// registry prefix and hash tag vary, so match on the last path segment of
// each local repository. `docker image ls` lists newest first.
//
// `wrangler deploy --dry-run` builds the images and then DELETES them before
// it exits (seen in CI: "Untagged ... Deleted: sha256:..."), so right after
// the dry-run there is usually nothing to inspect. When no image is found,
// rebuild it here from the same Dockerfile context: the daemon's layer cache
// is still warm from the dry-run, so this is seconds, not the full build.
let localImages;
function listLocalImages() {
  localImages ??= execFileSync('docker', ['image', 'ls', '--format', '{{.Repository}}:{{.Tag}}'], {
    encoding: 'utf8',
  })
    .split('\n')
    .filter(Boolean);
  return localImages;
}

function findTag(className) {
  const wanted = `${workerName}-${className.toLowerCase()}`;
  const tag = listLocalImages().find((ref) => {
    const repo = ref.slice(0, ref.lastIndexOf(':'));
    return repo.split('/').pop() === wanted;
  });
  return tag ?? null;
}

function buildForGate(container) {
  const dockerfile = join(root, container.image);
  const context = dirname(dockerfile);
  const tag = `${workerName}-${container.class_name.toLowerCase()}:gate`;
  console.log(`no local image for ${container.class_name}; building ${tag} from ${container.image} (cache-warm from the dry-run)`);
  execFileSync(
    'docker',
    ['build', '--platform', 'linux/amd64', '-f', dockerfile, '-t', tag, context],
    { stdio: ['ignore', 'inherit', 'inherit'] },
  );
  localImages = null;
  return tag;
}

function sizeBytes(container) {
  const className = container.class_name;
  const override = process.env[`IMAGE_SIZE_OVERRIDE_${className.toUpperCase()}`];
  if (override !== undefined && override !== '') {
    const n = Number(override);
    if (!Number.isFinite(n)) throw new Error(`IMAGE_SIZE_OVERRIDE_${className.toUpperCase()} is not a number`);
    return n;
  }
  const tag = findTag(className) ?? buildForGate(container);
  const out = execFileSync('docker', ['image', 'inspect', '--format', '{{.Size}}', tag], {
    encoding: 'utf8',
  });
  return Number(out.trim());
}

const pad = (s, n) => String(s).padEnd(n);
console.log(`${pad('class', 12)} ${pad('size_gb', 8)} ${pad('disk_gb', 8)} ratio`);
let failed = false;
for (const c of config.containers ?? []) {
  const disk = diskMb(c.instance_type) * 1e6;
  const size = sizeBytes(c);
  const ratio = size / disk;
  console.log(
    `${pad(c.class_name, 12)} ${pad((size / 1e9).toFixed(2), 8)} ${pad((disk / 1e9).toFixed(2), 8)} ${ratio.toFixed(3)}`,
  );
  if (size > disk * THRESHOLD) {
    failed = true;
    console.error(
      `::error::${c.class_name} image is ${(size / 1e9).toFixed(2)} GB uncompressed, over ${THRESHOLD * 100}% of its ` +
        `${(disk / 1e9).toFixed(2)} GB disk (limit ${((disk * THRESHOLD) / 1e9).toFixed(2)} GB). ` +
        `Shrink the image or raise instance_type disk in wrangler.jsonc.`,
    );
  }
}
process.exit(failed ? 1 : 0);
