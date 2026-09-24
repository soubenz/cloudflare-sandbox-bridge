# When the machine disappears

About a minute in, the process supervisor inside your container is killed.
Cloudflare replaces the container; the session notices, rebuilds what it
can, and carries on. This lab exists so you see that happen once, under
controlled conditions, before it happens during work you care about.

## Your task

The same trivial task as the smoke-test lab, so the restart is the
interesting part rather than a distraction:

```bash
echo -n "$GREETING" > /workspace/greeting.txt
```

Do it **now**, before the restart. Then watch.

## What to watch

Keep an eye on **Lab activity** in the right pane. You should see the
container reported as replaced, then services coming back, then the session
returning to running. The terminal will reconnect on its own.

## What survives, and what does not

This is the part worth internalising:

- **Your shell survives.** It runs inside tmux, so your working directory,
  your environment and your scrollback are still there after the terminal
  reconnects.
- **Files you wrote survive** *if* the filesystem outlived the container.
  When it did not, the lab's starting files are laid down again — and
  anything you wrote is gone.
- **Running processes do not survive.** Services are relaunched from the
  manifest, in dependency order. Anything you started by hand is not.

After the restart, check whether your file is still there:

```bash
cat /workspace/greeting.txt
```

If it is gone, write it again. That is the lesson: in a real lab, take a
snapshot before you have something you would hate to lose.

## Checking your work

**Run checks** looks only at whether `greeting.txt` holds the right value —
it does not care whether you wrote it before or after the restart.
