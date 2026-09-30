# Hints

These are the same three hints the session sends you automatically, timed
to roughly 15%, 30% and 45% of the way through your session -- they're
just written here too since this file is visible from the start. Try to
hold off reading ahead of where you actually are.

## Hint 1 (~15%)

Run `python3 -B send_calls.py english` and then `python3 -B send_calls.py
spanish`, and open the view tab after each. The English call's name,
email, phone number and SSN all get replaced. The Spanish call's name
does not -- look at what `gateway/hooks/pii_guard.py` actually configures
Presidio with.

## Hint 2 (~30%)

Presidio doesn't know Spanish out of the box -- it delegates entity
recognition to a spaCy model, and `pii_guard.py` only ever loads
`en_core_web_sm`. Loading a second small model (`es_core_news_sm`) for
Spanish, and asking Presidio to analyze each message under both languages
instead of just English, is the whole fix. Neither model needs
downloading at runtime -- they're already on disk (see the isolated venv
under `/opt/opalix/venvs/presidio`).

## Hint 3 (~45%)

Two gotchas, both easy to lose an hour to:

1. If you test with a "placeholder" SSN like `123-45-6789`, Presidio will
   never flag it -- its SSN recognizer deliberately rejects several
   well-known sample values (`123-45-6789`, `987-65-4320`, `078-05-1120`)
   on purpose, as known test data. Use a different-looking fake SSN (like
   `234-56-7890`) when you test by hand, or you'll conclude your fix
   doesn't work when it actually does.
2. After editing `pii_guard.py`, restart the `litellm` service from the
   Services panel -- it's imported once at boot, so the running gateway
   keeps using the old code until you do.
