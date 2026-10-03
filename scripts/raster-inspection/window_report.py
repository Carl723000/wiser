"""Pure native-window validation and statistics; implementation follows Red tests."""


def validate_selection(grid, selection, *, channels, bytes_per_value=8):
    raise NotImplementedError("native window validation")


def summarize_window(grid, selection, products, *, quality_policy, quality=None):
    raise NotImplementedError("native window statistics")
