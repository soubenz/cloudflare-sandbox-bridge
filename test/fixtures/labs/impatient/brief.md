# Sessions do not wait forever

Every lab session has two clocks: a hard timeout, and a much shorter idle
timeout. This lab sets the idle timeout to one minute — the schema minimum
— so you can watch both fire in the time it takes to read this.

## Your task

The same one-liner as the smoke-test lab:

```bash
echo -n "$GREETING" > /workspace/greeting.txt
```

Then stop touching anything, and watch what the session does.

## What counts as activity

The idle clock resets on things you actually do, not on the page being
open:

- typing in the terminal
- writing, deleting or saving a file
- running the checks
- restarting a service
- loading a service UI through its tab

Watching the timer in the top bar is not activity. Neither is reading this.

## What you should see

**Lab activity** will warn you before the session is reclaimed, and the
session ends shortly after if nothing happens. That is deliberate: a
forgotten tab should not keep a container running and billable for an hour.

In a real lab the idle timeout is ten minutes, and a snapshot is taken
before the session is reclaimed, so coming back is cheap. Here it is one
minute and there is nothing worth keeping.

## Checking your work

Press **Run checks** quickly if you want it to pass — and note that running
the checks is itself activity, so it pushes the idle deadline back.
