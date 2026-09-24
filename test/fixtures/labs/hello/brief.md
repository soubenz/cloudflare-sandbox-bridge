# Hello, sandbox

A smoke-test lab. It exists to prove the platform works end to end — a
container, a workspace, a shell, a service, and a grader — so the task
itself is deliberately trivial.

## Your task

Write the value of the `GREETING` environment variable to
`/workspace/greeting.txt`.

It is set for you in the shell. From the **Terminal** tab:

```bash
echo -n "$GREETING" > /workspace/greeting.txt
```

You can also do it from the **Editor** tab — create the file and type the
value in by hand. The grader checks the file's contents, not how you made
it, so either works.

## Checking your work

Press **Run checks** in the top bar. One check runs:

- `greeting-file-exists` — passes when `greeting.txt` holds exactly the
  value of `GREETING`, with no trailing newline.

If it fails, the reason says what the file actually contained.

## What else is here

- A file server on port 8000, proxied under the **echo** tab, serving
  `index.html` from your workspace.
- A pressure event about a minute in, to show how a lab interrupts you.
- A hint after two minutes, if you want one.
