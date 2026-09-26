"""Splits document text into overlapping chunks.

Given, working code -- not what this lab is about. Deterministic: the same
`text` always produces the same list of chunk strings in the same order,
which is what lets the rest of the pipeline reason about "the same chunk"
across two separate runs.
"""


def chunk_text(text, chunk_size=400, overlap=50):
    """Split `text` into chunks of roughly `chunk_size` characters, each
    overlapping the previous one by `overlap` characters. Returns a list of
    stripped, non-empty chunk strings, in order.
    """
    text = text.strip()
    if not text:
        return []
    if overlap >= chunk_size:
        raise ValueError("overlap must be smaller than chunk_size")

    chunks = []
    start = 0
    n = len(text)
    step = chunk_size - overlap
    while start < n:
        end = min(start + chunk_size, n)
        piece = text[start:end].strip()
        if piece:
            chunks.append(piece)
        if end >= n:
            break
        start += step
    return chunks
