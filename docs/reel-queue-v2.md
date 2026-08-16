# Reels v2 — the task queue

## In simple words

In v1, pressing the highlight button did everything right there and then: cut the
video, track the ball, add logos, upload to YouTube. All of it while a live match
was being streamed from the same little box. That works for one press. It does not
work when the system starts finding rallies on its own and wants to make dozens.

v2 splits the job in two:

1. **Grab the footage instantly** and write down a note saying "make a reel out of
   this later". Grabbing is nearly free — no video is processed, we just claim the
   raw chunks so nothing deletes them.
2. **Do the actual work later**, when no match is being streamed and the machine
   is sitting idle anyway.

The notes are the queue. One line per job, kept in a plain text file so you can
read it, and so a power cut can never leave it half-written.

## Why it's built this way

### The buffer is a moving window — miss it and it's gone forever

The rolling buffer only keeps the last ~45 seconds. There is no way to go back
and re-cut a highlight later. So the moment a trigger fires, the footage must be
claimed **immediately**, before anything else is decided.

Claiming is a hardlink: a second name for the same data on disk. It costs
microseconds and copies nothing. The retention sweeper can then delete its own
name freely — the data stays alive because we hold a reference.

This is what makes automatic detection affordable. Because claiming is free, the
detector is allowed to be trigger-happy; we sort out which ones are actually worth
publishing later, when it costs us nothing to think about it.

> This mechanism is not new in v2. It shipped in v1 (PR #38) to fix reels coming
> out at 9.12s instead of 30s — the sweeper was deleting segments while ffmpeg
> was still reading them, and ffmpeg truncated the output and exited 0.

### Never process while a stream is live

The box is a 4-core laptop that is already at ~99% CPU peak encoding a live match
(see the `Highlight resource usage` log line). Reel work at the same time is what
made v1 take 32 seconds to cut a 30-second clip.

So: **the worker only picks up a new task when no stream is running.** The app
already receives stream start/stop events over SSE, so it knows.

One deliberate exception. If a stream starts while a task is mid-flight, that task
**runs to completion in parallel** rather than being killed. Killing it would
waste the work already done and risk leaving half-written files, and one task
overlapping a stream is survivable at `nice 19`. What we must not do is *start
another one* — so the worker finishes what it holds and then stops until every
stream is down.

### Only record finished steps, never "in progress"

This is what makes crash recovery simple enough to trust.

Each step writes its output to a temp path, atomically renames it into place, and
only then appends the new state to the queue. If the power dies anywhere in that
sequence, the state on disk still points at the *last fully completed* step, and
re-running that step just overwrites its own output.

So recovery is not a special code path. It is the normal path: read the last
recorded state and continue. Every step must therefore be **idempotent** — safe
to run twice. That is a hard requirement on anything added to this pipeline.

The one thing we do record before a step is the **attempt count**, so a task that
crashes the process on every attempt is eventually given up on instead of putting
the box in a boot loop.

### Append-only, because a rewrite can be torn in half

The queue file is only ever appended to. A record is a complete snapshot of a
task, not a delta, so replaying means "last line wins per task id".

A partial line at the end of the file — the classic signature of a power cut
mid-write — is skipped during replay rather than treated as corruption. Rewriting
lines in place would risk destroying a *neighbouring* task's record, which is a
much worse failure than losing the tail of the file.

Compaction (dropping finished tasks) writes a new file and renames it over the
old one, which is atomic.

## The states

```
RAW        segments claimed on disk. The only step that is time-critical.
SCORED     motion/quality score computed. Cheap, and runs BEFORE any encode
           so a weak automatic candidate can be dropped without ever paying
           for one.
EXTRACTED  the window cut into a single clip
REFRAMED   ball-tracked vertical crop applied
RENDERED   logos/branding burned in — this is the finished reel
UPLOADED   YouTube returned a videoId
DONE       local files cleaned up

REJECTED   an automatic candidate that lost on ranking. Cleaned up without
           ever being encoded.
FAILED     gave up after N attempts. Files kept for inspection.
```

Manual (button) tasks skip `REJECTED` entirely — a human asked for that one, so
it is never dropped on ranking, and it sorts ahead of automatic candidates.

## What bounds the work

Automatic detection can over-trigger; that is by design, since claiming is free.
Three things stop it becoming unbounded:

- **A disk quota** on pending snapshots (count and MB). When it is hit, the
  lowest-scoring *automatic* candidates are evicted first. A manual task is never
  evicted.
- **A publish cap** per match/session, so a busy hour cannot produce fifty
  YouTube uploads.
- **Ranking before encoding**, so rejected candidates cost a score computation
  and nothing more.

## Files

```
<HIGHLIGHT_OUTPUT_DIR>/
  queue.jsonl                  the queue (append-only)
  <courtId>/
    .pin-<stamp>/              claimed raw segments (hardlinks)
    highlight-<stamp>.mp4      EXTRACTED
    reframed-highlight-*.mp4   REFRAMED
    reel-highlight-*.mp4       RENDERED — the finished reel
```

## Do not

- **Do not** put the buffer dir and the output dir on different filesystems.
  Hardlinks cannot cross one, claiming silently degrades to the old race, and
  reels start coming out short again. It is logged, but it is easy to miss.
- **Do not** add a pipeline step that is not idempotent. Recovery re-runs the
  last step, unconditionally.
- **Do not** record an "in progress" state. It creates a state that recovery
  cannot interpret — did it finish? — and the whole design avoids needing to ask.
- **Do not** let the worker start a task while any stream is running. The
  in-flight exception is deliberate and narrow.
