"""Strip personal data out of a request before it goes anywhere else.

Two teams' chat traffic passes through this gateway on its way to
`assistant` (services/fake_provider.py -- there is no real model behind
it, on purpose, so its own request log can be trusted as a witness). People
paste real customer messages into these calls, and those messages contain
real names, emails, phone numbers and SSNs often enough that it can't be
left to whoever is typing to remember to scrub it first.

Your job: make sure that by the time a call leaves this hook, its message
content has had that stuff redacted -- not flagged, not logged as a
warning, actually replaced with a placeholder -- so neither
services/fake_provider.py's own request log nor anything the gateway
itself traces ever shows the raw value. Both of those read the exact same
`data` dict this hook is handed, so whatever this function does to it in
place is what they will see; there is no separate "send" step to intercept
afterwards.

This file already does real work: it runs every message's content through
Presidio (an open-source PII detection/anonymization library -- see
https://microsoft.github.io/presidio/) and replaces whatever it finds with
a `<ENTITY_TYPE>` placeholder before the call is allowed to continue. Run
it against some English customer messages and it holds up. This team's
customers don't all write in English, though.

## Why Presidio needs help finding its own models

Presidio's `AnalyzerEngine` doesn't ship a language model itself -- it
delegates entity recognition to spaCy, and if you build a bare
`AnalyzerEngine()` with no configuration it defaults to trying to download
spaCy's large English model (`en_core_web_lg`, ~400MB) over the network the
first time it runs. This container's egress fence blocks that, so an
unconfigured AnalyzerEngine will simply fail the first time this hook
fires. The `NlpEngineProvider` config below instead names small,
pre-downloaded models explicitly (`en_core_web_sm`, ~15MB) -- see
`_build_analyzer()`.

## Why this file can `import presidio_analyzer` at all

Presidio and spaCy live in their own isolated Python install
(`/opt/opalix/venvs/presidio`), not in the same environment `litellm`
itself runs in -- spaCy's own dependency pins are a real risk against
litellm's and mlflow's, and nobody has proven they coexist in one
environment. The lines below add that install's `site-packages` to this
process's import path before reaching for presidio, so the two stay
physically separate but this hook can still use it directly, in-process,
the same way budget_guard.py (labs/hard-budget-per-team) reaches straight
into `user_api_key_dict` with no extra plumbing.
"""

import glob
import os
import sys

_PRESIDIO_VENV = "/opt/opalix/venvs/presidio"
for _site_packages in glob.glob(os.path.join(_PRESIDIO_VENV, "lib", "python3.*", "site-packages")):
    if _site_packages not in sys.path:
        sys.path.insert(0, _site_packages)

from litellm.integrations.custom_logger import CustomLogger
from presidio_analyzer import AnalyzerEngine
from presidio_analyzer.nlp_engine import NlpEngineProvider
from presidio_anonymizer import AnonymizerEngine

# What this hook looks for. Presidio recognizes many more entity types than
# this -- these are the ones this gateway's brief cares about.
ENTITIES = ["PERSON", "EMAIL_ADDRESS", "PHONE_NUMBER", "US_SSN", "CREDIT_CARD"]


def _build_analyzer():
    # Small, explicit models only -- see this file's top-of-file comment
    # for why a bare AnalyzerEngine() is not an option here.
    nlp_engine = NlpEngineProvider(
        nlp_configuration={
            "nlp_engine_name": "spacy",
            "models": [
                {"lang_code": "en", "model_name": "en_core_web_sm"},
            ],
        }
    ).create_engine()
    return AnalyzerEngine(nlp_engine=nlp_engine, supported_languages=["en"])


_analyzer = _build_analyzer()
_anonymizer = AnonymizerEngine()


def _redact_text(text):
    if not text:
        return text
    results = _analyzer.analyze(text=text, language="en", entities=ENTITIES)
    if not results:
        return text
    return _anonymizer.anonymize(text=text, analyzer_results=results).text


class PIIGuard(CustomLogger):
    async def async_pre_call_hook(
        self,
        user_api_key_dict,
        cache,
        data: dict,
        call_type: str,
    ):
        for message in data.get("messages") or []:
            content = message.get("content")
            if isinstance(content, str):
                message["content"] = _redact_text(content)
        return None


pii_guard_instance = PIIGuard()
