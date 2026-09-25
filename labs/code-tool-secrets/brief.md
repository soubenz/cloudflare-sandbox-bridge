# The code tool read the secrets file

The research desk is an agent, and one of the things it can do is write a
short Python program and run it. That is genuinely useful: somebody asks for a
number, the desk writes four lines of arithmetic instead of guessing, and the
answer is right. It reads a spreadsheet somebody attached and hands back a
summary. It is the most-used tool the desk has.

On Tuesday afternoon Priya Raghunathan in Ops asked it, in a channel with
forty people in it, to "read the config and tell me what's in it". The desk
wrote six lines, the tool ran them, and the answer came back in the channel:
the service name, the region, the database connection string with the password
in it, and the live API key. The key has been rotated. The channel history has
not, and neither has the tool.

Nobody did anything wrong that day except build a tool that would do that. The
program was a perfectly ordinary program. It ran because nothing stopped it.

## What you have

| Where | What |
|---|---|
| `run_tool.py` | The entry point. The graders run this exact command; see below. |
| `tool/` | The tool: config, the working directory, the resource limits, the child's start-up, the runner, and the bit that files a run with the auditor. |
| `programs/` | Three programs to try it with, including `read_the_config.py` -- the one from Tuesday, kept so the incident can be reproduced rather than argued about. |
| `data/sales.csv` | Something to hand a program that has a reason to read a file. |
| `config/` | The desk's own configuration, and the vault's seed file. Both real, both full of credentials, and both none of a program's business. |
| **auditor** tab | Every run the tool performed, what it printed, and -- in red -- whether what it printed contained one of this container's credentials. |

Two services are running. The **auditor** on port 8754 is the tab above: it is
told about every run and it knows the exact value of every credential in this
container, so a run it flags really did print one. The **vault** on port 8755
is the credential store, and it is not proxied -- read it from the terminal
with `curl "$VAULT_URL/api/log"`. It writes down every request it receives.
Nothing in the agent calls it at run time and the tool never calls it, so a
line in that log came from something that was not supposed to be making
requests.

Start here, in the **Terminal**:

```bash
python3 run_tool.py programs/read_the_config.py
```

Then open the **auditor** tab and look at the row it just made.

## Your task

Build the boundary the tool never had.

A program the tool runs must not be able to:

- read a file outside the working directory it was given -- any file, not just
  the ones this brief mentions;
- write outside it either;
- reach the network, including the loopback interface, where the vault is;
- take the credentials out of its process environment;
- use more processor time, memory or disk than the desk allows it;
- see anything a previous run left behind.

And the tool has to keep doing its job, which is the harder half. All of this
must still work:

- arithmetic, and the standard library it takes to do arithmetic -- `import
  statistics` has to keep working after whatever you install;
- reading a file the caller placed in the working directory (`--input`);
- writing files in the working directory and having them come back as the
  run's outputs;
- ordinary file work inside that directory: making a subdirectory, renaming,
  removing, listing, `stat`;
- a refusal reported *as* a refusal, with a reason, and filed with the
  auditor. The agent acts on that record; "it completed" when it did not is
  worse than no sandbox at all.

A tool that refuses everything satisfies the first list perfectly and is
graded on the second.

**The entry point.** The graders feed programs in the way a model does -- as
text, not as a file:

```bash
python3 run_tool.py --label some-name < program.py
python3 run_tool.py --label with-a-file --input data/sales.csv < program.py
```

Keep that working. The `--label` is the name the run is filed under and it is
how the graders find it, so pass it through; keep every run filed with the
auditor, whether it completed or not; and keep the `outputs` in the filing,
because a run whose output files never came back did the work and threw it
away.

**One thing about who you are.** Your shell here is the unprivileged `learner`
user. The graders run as `root`, and they drop to `learner` to run your tool,
because a boundary that only holds when the tool happens to be privileged is
not a boundary you could ship. So it cannot be built out of `chroot`, a
`setuid` to somebody harmless, or a file mode only root can set. Whatever you
build has to hold when the tool is nobody in particular.

## What this container actually gives you, and what it does not

Be clear about this before you start, because it changes what the right answer
looks like.

This platform gives you **process-level isolation only**. There is no virtual
machine per run and no container per run. The program you execute runs as an
ordinary process beside the tool: same kernel, same filesystem, same network
namespace, same user. That is the platform, and it is the platform the tool
has to be safe on.

So the boundary that is available to you is: a working directory the program
is confined to, an environment it inherits nothing from, ceilings on what it
may consume, and a refusal that happens before the operation rather than after
it. Built properly, that stops every program in the list above, on this
platform, today -- which is the only claim worth making about a boundary.

What it does not buy you, stated plainly, because a boundary you are wrong
about is worse than one you know the shape of:

- **It is enforced by the interpreter, so it ends where the interpreter ends.**
  Anything that reaches the kernel without going through Python -- a native
  extension, `ctypes` -- is outside what the interpreter can report on. You can
  refuse the ways in that you know of. You cannot promise there is no other.
- **It is not a defence against a kernel bug.** A local privilege escalation
  ends this conversation, and nothing you write today changes that.
- **The limits bound one process tree, not the machine.** A program inside its
  allowance can still make the box slow for everybody else.
- **It says nothing about timing, or about what the program infers** from how
  long an allowed operation took.
- **It is a layer, not an absolution.** The strongest thing anyone could have
  done on Tuesday was to not keep a live API key in a file next to a tool
  whose entire purpose is running code somebody else wrote. Build the boundary;
  it is worth building. Then go and move the key.

There is no internet from this container. `python3 -m pydoc <name>` works
offline and is the documentation you have.

## Checking your work

**Run checks** resets both services, feeds a battery of programs to *your*
`run_tool.py`, and grades what the services and the filesystem recorded.
Nothing reads your source, so any boundary that actually holds passes and no
boundary that only looks like one does.

The battery is not in your workspace and you cannot read it. What you are told
about it is this: it contains paths, files, spellings and library calls that
this brief does not mention, on purpose. A boundary that has to know in
advance which files are worth protecting is a boundary around the files
somebody remembered, and that is the thing this lab exists to rule out.

| Check | Passes when |
|---|---|
| `hostile-programs-are-refused` | Every program that reached outside its working directory was refused, the refusal was recorded with a reason, no credential appeared in any run's output, and the vault received nothing. |
| `real-programs-still-run` | Ordinary programs still run, still get their input file, still hand back their output file, and still come back with the right answers. |
| `runs-do-not-leak-into-each-other` | A file one run wrote is not there for the next one. |

The second one is not a formality. It is the check that separates a boundary
from a broken tool, and it is weighted the same as the first. You need all
three.

## Worth knowing

A process inherits more than anyone intends it to. Its working directory, its
environment, its open file descriptors, its resource ceilings, its network
namespace -- all of that arrives by default, decided by whatever started it,
for reasons that had nothing to do with running somebody else's code. Most of
those defaults can be changed at the moment the process is created, by the
code doing the creating, and that is the cheap half of this problem.

The expensive half is that "do not open that file" is not one of them. Opening
a file the tool's own user can read is not a resource the process was handed;
it is a thing the process can ask the kernel for, and the kernel has no
opinion about which of your files are secrets. With no container and no second
user to hide behind, the only place left to make that decision is inside the
process, before the call reaches the kernel -- which means it has to be code
that runs after the interpreter has started and before the program does, and
that cannot be taken back out afterwards by the program it is there to check.

Python has somewhere to put that. Finding it is most of the lab.

And when you do: the difference between a boundary and a blocklist is which
way round it fails. A rule that lists what is forbidden says yes to everything
nobody thought of. A rule that names the one directory that is allowed says no
to everything nobody thought of. They cost the same to write.
