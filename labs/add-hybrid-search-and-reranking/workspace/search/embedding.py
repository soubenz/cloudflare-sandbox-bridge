"""A deterministic pseudo-embedding: a stand-in for a real text-embedding
model.

Given, not the part you build -- see fusion.py for that. This module is
used identically to embed a document at ingestion time and to embed a
caller's query string at search time, the same way a real system calls one
embedding model for both.

A fixed table maps a small set of *concepts* to trigger phrases (substrings
of lowercased, punctuation-collapsed text). embed(text) finds which
concepts' phrases occur in the text and sums those concepts' fixed
pseudo-random unit vectors, then normalizes. Two pieces of text that share
almost no vocabulary still land close together in vector space if they
trigger the same concept through different phrasing -- e.g. "won't hold the
set temperature" and "goes warm then cold every few minutes" both trigger
`short_cycle` below, even though they share no words at all. And two pieces
of text that differ only in an exact code or number (e.g. "E-47" vs "E-52")
land at the SAME vector, because neither code is itself a trigger phrase --
this is a real property of real embedding models too: they capture topic,
not exact identifiers, which is exactly why keyword search still matters.
"""
import hashlib
import math
import random
import re

DIM = 24

CONCEPTS = {
    "short_cycle": [
        "short-cycle", "short cycle", "short-cycling", "short cycling",
        "turns on and off", "on and off every", "warm then cold",
        "cycles rapidly", "rapid on/off", "on, off, on, off",
        "temperature swings", "won't hold the set temperature",
    ],
    "sensor_fault": [
        "sensor fault", "recalibrate", "recalibration", "sensor error",
        "ambient sensor", "return-air sensor", "faulty reading",
        "replace the sensor", "sensor is misreading",
    ],
    "filter_clog": [
        "clogged filter", "dirty filter", "reduced airflow", "weak airflow",
        "replace the filter", "dust buildup", "filter is blocking",
    ],
    "wifi_pairing": [
        "won't connect to wifi", "can't pair", "pairing fails",
        "network setup", "join the network", "wifi setup",
        "app can't find the device", "bluetooth pairing",
    ],
    "firmware_update": [
        "firmware update", "update failed", "stuck updating",
        "update is stuck", "won't update", "software update",
    ],
    "battery_backup": [
        "backup battery", "resets after a power outage", "loses its schedule",
        "power outage", "battery backup", "forgets the time after power loss",
    ],
    "humidity_control": [
        "humidity", "condensation", "musty smell", "mold", "too humid",
        "dehumidify",
    ],
    "geofencing": [
        "geofencing", "away mode", "based on my phone's location",
        "location-based", "leaves the house", "arrives home",
    ],
    "multi_zone": [
        "multiple thermostats", "zones are out of sync", "second floor zone",
        "zone controller", "upstairs and downstairs disagree",
    ],
    "voice_assistant": [
        "alexa", "google home", "voice assistant", "voice command",
        "hey google", "ask alexa",
    ],
    "api_rate_limit": [
        "rate limit", "429", "too many requests", "throttled", "throttling",
        "quota exceeded", "back off and retry",
    ],
    "schedule_sync": [
        "schedule doesn't sync", "schedules out of sync", "polling too often",
        "sync the schedule", "schedule sync",
    ],
    "installation_wiring": [
        "c-wire", "blank screen", "won't power on", "wiring", "no power",
        "screen stays black",
    ],
    "energy_reports": [
        "energy report", "usage report", "monthly report", "usage history",
        "runtime report",
    ],
}

_CONCEPT_VECS = {}


def _normalize(text):
    """Lowercase and collapse every run of non-alphanumeric characters to a
    single space, so trigger-phrase matching doesn't care about commas,
    hyphens, apostrophes or extra whitespace."""
    return re.sub(r"[^a-z0-9]+", " ", (text or "").lower()).strip()


def _concept_vector(concept_id):
    if concept_id in _CONCEPT_VECS:
        return _CONCEPT_VECS[concept_id]
    seed = int.from_bytes(hashlib.sha256(concept_id.encode("utf-8")).digest(), "big")
    rnd = random.Random(seed)
    vals = [rnd.uniform(-1.0, 1.0) for _ in range(DIM)]
    norm = math.sqrt(sum(v * v for v in vals)) or 1.0
    vec = [v / norm for v in vals]
    _CONCEPT_VECS[concept_id] = vec
    return vec


def embed(text):
    """Returns (vector, concepts_matched). vector is a length-DIM list of
    floats, L2-normalized (safe to store directly as a pgvector column and
    compare with cosine distance `<=>`)."""
    t = _normalize(text)
    hits = [
        c for c, phrases in CONCEPTS.items()
        if any(_normalize(p) in t for p in phrases)
    ]
    if not hits:
        # No recognized concept -- fall back to a stable hash of the raw
        # text so nothing ever embeds to an all-zero vector (a real
        # embedding model never returns a null vector either). This is
        # deliberately uncorrelated with any concept: a query that doesn't
        # name anything this table recognizes gets an effectively arbitrary
        # vector, the same way an out-of-domain query confuses a real
        # embedding model too.
        hits = ["__fallback__:" + t[:64]]
    acc = [0.0] * DIM
    for c in hits:
        vec = _concept_vector(c)
        for i in range(DIM):
            acc[i] += vec[i]
    norm = math.sqrt(sum(v * v for v in acc)) or 1.0
    return [v / norm for v in acc], hits


def to_pgvector_literal(vec):
    return "[" + ",".join(f"{x:.8f}" for x in vec) + "]"
