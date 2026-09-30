"""Reference solution for labs/strip-personal-data-before-it-leaves.

The workspace skeleton's gap: `_build_analyzer()` only ever loaded
`en_core_web_sm`, and `_redact_text()` only ever asked Presidio to analyze
text as `language="en"`. Against English messages that looks completely
correct -- names, emails, phone numbers and SSNs all get replaced. Against
a Spanish-language message, Presidio's English pipeline still runs (it
never errors), it just doesn't recognize `Maria Garcia` as a `PERSON` in a
Spanish sentence the way its Spanish pipeline would, so the message sails
through unredacted while every check that only ever sent English text kept
passing.

The fix: also load `es_core_news_sm` (Presidio doesn't touch the network
for either -- see the workspace file's comment on why a bare
`AnalyzerEngine()` would), and analyze every message under both languages
instead of guessing which one a message is in. A message is short customer
text, not a novel -- running it through two small spaCy pipelines instead
of one is cheap, and it sidesteps needing a language-detection step (and a
misdetection on a two-line message) entirely.

One more real gap that only shows up in Spanish: Presidio's built-in
`UsSsnRecognizer` is a plain regex/context recognizer -- SSNs are still
9 digits in dashes no matter what language surrounds them -- but Presidio
only registers it for `language="en"` by default, so a Spanish message
with an SSN in it still wouldn't be caught even with the Spanish model
loaded. Registering the same recognizer again for `es` costs nothing and
closes that gap too.
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
from presidio_analyzer.predefined_recognizers import UsSsnRecognizer
from presidio_anonymizer import AnonymizerEngine

ENTITIES = ["PERSON", "EMAIL_ADDRESS", "PHONE_NUMBER", "US_SSN", "CREDIT_CARD"]
LANGUAGES = ["en", "es"]


def _build_analyzer():
    nlp_engine = NlpEngineProvider(
        nlp_configuration={
            "nlp_engine_name": "spacy",
            "models": [
                {"lang_code": "en", "model_name": "en_core_web_sm"},
                {"lang_code": "es", "model_name": "es_core_news_sm"},
            ],
        }
    ).create_engine()
    analyzer = AnalyzerEngine(nlp_engine=nlp_engine, supported_languages=LANGUAGES)
    # UsSsnRecognizer is regex/context-based, not NLP-model-based -- the
    # entity it looks for doesn't change shape by language, only Presidio's
    # default registration of it does.
    analyzer.registry.add_recognizer(UsSsnRecognizer(supported_language="es"))
    return analyzer


_analyzer = _build_analyzer()
_anonymizer = AnonymizerEngine()


def _analyze_all_languages(text):
    """Runs every configured language's pipeline over `text` and returns one
    non-overlapping list of results, highest-confidence span wins.

    A message's language isn't known ahead of time, and guessing wrong on a
    short customer message is easy to get wrong -- so every language is
    tried, and the results are merged: the same identical span found by more
    than one language's pass keeps a single entry, and any *different* spans
    that happen to overlap keep only the highest-scoring one, since the
    anonymizer below expects non-conflicting spans.
    """
    combined = []
    seen_spans = set()
    for language in LANGUAGES:
        for result in _analyzer.analyze(text=text, language=language, entities=ENTITIES):
            key = (result.start, result.end, result.entity_type)
            if key in seen_spans:
                continue
            seen_spans.add(key)
            combined.append(result)

    combined.sort(key=lambda r: (-r.score, r.start))
    chosen = []
    covered = []
    for result in combined:
        if any(not (result.end <= c_start or result.start >= c_end) for c_start, c_end in covered):
            continue
        covered.append((result.start, result.end))
        chosen.append(result)
    return chosen


def _redact_text(text):
    if not text:
        return text
    results = _analyze_all_languages(text)
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
        # Mutate `data`'s own message dicts in place, not a copy of them --
        # this is the exact same `data` object LiteLLM sends on to the
        # model and threads through to its own logging/tracing callbacks
        # afterwards, so redacting anything less than this object itself
        # would still leak the raw text to both.
        for message in data.get("messages") or []:
            content = message.get("content")
            if isinstance(content, str):
                message["content"] = _redact_text(content)
        return None


pii_guard_instance = PIIGuard()
