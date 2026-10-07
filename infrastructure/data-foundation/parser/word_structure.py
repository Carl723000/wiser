"""Private full OOXML structure reader; legacy record extraction is separate."""


class WordStructureError(Exception):
    def __init__(self, reason):
        super().__init__(reason)
        self.reason = reason


def extract_word_structure(content, maximum_bytes=64 * 1024 * 1024):
    raise NotImplementedError("Full Word structure extraction is not implemented")
