#!/bin/sh
# Builds a Postgres data directory with LiteLLM's schema already migrated,
# at image build time, so a lab session never runs migrations.
#
# Why: on a fresh database LiteLLM's first boot runs all of its bundled
# migrations and then a post-migration sanity check. Measured on one core
# (docs/spike.md, "LiteLLM boot time: where it goes"), that is ~13 s of a
# 30 s boot -- most of the 77 s a gateway session took to reach `running`
# live. A lab's postgres service copies this directory into /tmp/pg
# instead of running initdb, and LiteLLM boots with
# DISABLE_SCHEMA_UPDATE=True so it doesn't re-check a schema that is known
# to be current.
#
# Two databases come out of it:
#   postgres          -- the one a lab's LiteLLM uses (DATABASE_URL .../postgres)
#   litellm_template  -- an identical copy that nothing ever connects to, for
#                        graders: `CREATE DATABASE grading TEMPLATE
#                        litellm_template` is instant, and CREATE DATABASE
#                        ... TEMPLATE refuses if anything is connected to the
#                        source, which the live `postgres` database always is.
#
# The migrations are the ones LiteLLM itself runs at boot: `prisma migrate
# deploy` from inside the litellm_proxy_extras package, which holds both
# schema.prisma and migrations/. The Prisma CLI was already downloaded by
# the `prisma generate` step before this one.
#
# Usage: build-pg-template.sh <data-dir>
set -eu

DATA_DIR="$1"
PGBIN="$(ls -d /usr/lib/postgresql/*/bin | head -n1)"
PORT="${PG_TEMPLATE_BUILD_PORT:-5432}"  # overridable only for a local dry run
PSQL="runuser -u postgres -- $PGBIN/psql -h 127.0.0.1 -p $PORT -U postgres -v ON_ERROR_STOP=1 -Atc"

install -d -o postgres -g postgres -m 700 "$DATA_DIR"
runuser -u postgres -- "$PGBIN/initdb" -D "$DATA_DIR" --auth=trust -U postgres >/dev/null
# initdb picks POSIX shared memory when the machine it runs on has
# /dev/shm, and the image builder does. Lab containers don't, and Postgres
# then dies at startup with `could not open shared memory segment
# "/PostgreSQL.<n>"` (seen live, 26 Sep 2026). When initdb itself ran
# inside a lab container it chose System V, which works there, so pin
# that. Later settings in postgresql.conf win. The build's own start below
# uses it, so a builder that can't do System V fails here, not in a lab.
echo "dynamic_shared_memory_type = sysv" >> "$DATA_DIR/postgresql.conf"
runuser -u postgres -- "$PGBIN/pg_ctl" -D "$DATA_DIR" -w \
  -o "-c listen_addresses=127.0.0.1 -p $PORT -k /tmp" -l /tmp/pg-template-build.log start

stop() { runuser -u postgres -- "$PGBIN/pg_ctl" -D "$DATA_DIR" -m fast -w stop >/dev/null; }
trap stop EXIT

EXTRAS="$(python3 -c "import litellm_proxy_extras, os; print(os.path.dirname(litellm_proxy_extras.__file__))")"
(cd "$EXTRAS" && DATABASE_URL="postgresql://postgres@127.0.0.1:$PORT/postgres" prisma migrate deploy)

$PSQL "CREATE DATABASE litellm_template TEMPLATE postgres" >/dev/null

# Fail the build loudly rather than ship a template LiteLLM would reject.
[ "$($PSQL "SHOW dynamic_shared_memory_type")" = sysv ] \
  || { echo "dynamic_shared_memory_type is not sysv" >&2; exit 1; }
for db in postgres litellm_template; do
  applied="$($PSQL "SELECT count(*) FROM _prisma_migrations WHERE finished_at IS NOT NULL" -d "$db")"
  [ "$applied" -gt 100 ] || { echo "only $applied migrations applied in $db" >&2; exit 1; }
  tables="$($PSQL "SELECT count(*) FROM information_schema.tables WHERE table_name = 'LiteLLM_TeamTable'" -d "$db")"
  [ "$tables" = 1 ] || { echo "LiteLLM_TeamTable missing in $db" >&2; exit 1; }
  echo "$db: $applied migrations applied"
done
rm -f /tmp/pg-template-build.log
