"""pixatar for Python: deterministic Pixel Agents avatars as PNG, drawn by the pixatar npm
package's own CLI (Node 22+), so every pixel matches the JavaScript package's.

    import pixatar

    png = pixatar.avatar_png("octocat", scale=8)  # bytes: a 160x160 PNG
"""

from ._client import (
    ENV_VAR,
    Character,
    Pixatar,
    PixatarError,
    avatar_png,
    default_client,
    find_cli,
    info,
    sheet_png,
)

__all__ = [
    "ENV_VAR",
    "Character",
    "Pixatar",
    "PixatarError",
    "avatar_png",
    "default_client",
    "find_cli",
    "info",
    "sheet_png",
]
