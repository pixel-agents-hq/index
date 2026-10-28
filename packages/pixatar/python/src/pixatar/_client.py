"""The client: one long-lived ``pixatar serve`` process, spoken to in JSON lines."""

from __future__ import annotations

import atexit
import base64
import collections
import json
import os
import shlex
import shutil
import subprocess
import threading
from dataclasses import dataclass
from typing import Any, Deque, Dict, List, Optional, Sequence, Union

#: The environment variable that names the pixatar command, e.g. ``node /path/to/cli.js``.
ENV_VAR = "PIXATAR_CLI"

Command = Union[str, Sequence[str]]


class PixatarError(Exception):
    """A seed, request or CLI problem. ``code`` says which.

    From the CLI: ``invalid-seed``, ``unknown-part``, ``invalid-profile``,
    ``invalid-request``, ``internal-error``. From this client: ``cli-not-found`` (no
    pixatar command to run) and ``cli-exited`` (the command stopped; ``message`` holds
    what it printed).
    """

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message

    def __str__(self) -> str:
        return f"{self.message} ({self.code})"


@dataclass(frozen=True)
class Character:
    """Everything about a character that isn't pixels."""

    #: Its seed code: give it back for this exact character and avatar.
    seed: str
    #: Its background colour, ``#rrggbb`` (also when its avatar is transparent).
    background: str
    #: What its avatar is drawn on: ``'color'`` or ``'transparent'``.
    avatar_background: str
    #: Its Pixel Agents character profile.
    profile: Dict[str, Any]


def find_cli(command: Optional[Command] = None) -> List[str]:
    """The pixatar command as an argv list: ``command`` if given, else ``$PIXATAR_CLI``,
    else ``pixatar`` on the PATH. A string is split like a shell would split it (on Windows,
    keeping backslashes: ``node "C:\\pixatar\\cli.js"``)."""
    if command is None:
        command = os.environ.get(ENV_VAR) or None
    if command is None:
        found = shutil.which("pixatar")
        if found is None:
            raise PixatarError(
                "cli-not-found",
                f"No pixatar command: install the pixatar npm package (Node 22+), or set "
                f"{ENV_VAR}, e.g. {ENV_VAR}='node /path/to/pixatar/dist/cli.js'.",
            )
        return [found]
    if isinstance(command, str):
        # POSIX rules would eat a Windows path's backslashes
        posix = os.name != "nt"
        argv = [a if posix else a.strip('"') for a in shlex.split(command, posix=posix)]
    else:
        argv = list(command)
    if not argv:
        raise PixatarError("cli-not-found", "The pixatar command is empty.")
    return argv


class Pixatar:
    """A pixatar CLI process, started on first use and reused for every call after.

    Calls are thread-safe (one at a time over the one process). If the process stops, the
    call raises ``PixatarError('cli-exited')`` and the next call starts a new one. Use it
    as a context manager, or call :meth:`close`.
    """

    def __init__(self, command: Optional[Command] = None) -> None:
        self._argv = find_cli(command) + ["serve"]
        self._lock = threading.Lock()
        self._proc: Optional[subprocess.Popen[str]] = None
        self._stderr: Deque[str] = collections.deque(maxlen=50)
        self._drainer: Optional[threading.Thread] = None
        self._next_id = 0

    def __enter__(self) -> Pixatar:
        return self

    def __exit__(self, *exc: object) -> None:
        self.close()

    def avatar_png(
        self,
        seed: str,
        *,
        scale: int = 1,
        background: Optional[str] = None,
        text: bool = False,
    ) -> bytes:
        """The avatar as PNG bytes: ``20 * scale`` pixels square.

        ``seed`` is a seed code (``px.…``) or any free text; ``text=True`` reads one that
        starts with ``px.`` as text. ``background`` (``'color'`` or ``'transparent'``)
        overrides what the seed code says.
        """
        r = self._call("avatar", seed=seed, scale=scale, background=background, text=text)
        return base64.b64decode(r["png"])

    def sheet_png(self, seed: str, *, scale: int = 1, text: bool = False) -> bytes:
        """The transparent sprite sheet as PNG bytes: ``128 * scale`` by ``96 * scale``."""
        r = self._call("sheet", seed=seed, scale=scale, text=text)
        return base64.b64decode(r["png"])

    def info(self, seed: str, *, background: Optional[str] = None, text: bool = False) -> Character:
        """The character a seed stands for: its seed code, colours and profile."""
        r = self._call("info", seed=seed, background=background, text=text)
        return Character(r["seed"], r["background"], r["avatarBackground"], r["profile"])

    def version(self) -> Dict[str, Any]:
        """``{'version': <pixatar>, 'vendor': {'version': <pixel-agents>, 'commit': …}}``."""
        r = self._call("version")
        return {"version": r["version"], "vendor": r["vendor"]}

    def close(self) -> None:
        """Stop the process (a later call starts a new one)."""
        with self._lock:
            self._stop()

    def _call(self, op: str, **fields: Any) -> Dict[str, Any]:
        request: Dict[str, Any] = {"op": op}
        request.update({k: v for k, v in fields.items() if v is not None and v is not False})
        with self._lock:
            proc = self._proc if self._proc and self._proc.poll() is None else self._start()
            self._next_id += 1
            request["id"] = self._next_id
            assert proc.stdin and proc.stdout
            try:
                proc.stdin.write(json.dumps(request) + "\n")
                proc.stdin.flush()
                line = proc.stdout.readline()
            except (BrokenPipeError, OSError):
                line = ""
            if not line:
                raise self._exited()
        response = json.loads(line)
        if not response.get("ok"):
            error = response.get("error") or {}
            raise PixatarError(error.get("code", "internal-error"), error.get("message", line))
        return response

    def _start(self) -> subprocess.Popen[str]:
        self._stop()
        self._stderr.clear()
        try:
            proc = subprocess.Popen(
                self._argv,
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
                encoding="utf-8",
            )
        except OSError as e:
            raise PixatarError("cli-not-found", f"Could not run {self._argv[0]}: {e}") from e
        # drained as it comes, so a chatty process can't block on a full pipe
        self._drainer = threading.Thread(target=self._drain, args=(proc,), daemon=True)
        self._drainer.start()
        self._proc = proc
        return proc

    def _drain(self, proc: subprocess.Popen[str]) -> None:
        assert proc.stderr
        for line in proc.stderr:
            self._stderr.append(line)

    def _exited(self) -> PixatarError:
        proc, self._proc = self._proc, None
        code = None
        if proc:
            try:
                code = proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                proc.kill()
        if self._drainer:
            self._drainer.join(timeout=1)
        said = "".join(self._stderr).strip()
        message = f"The pixatar command ({' '.join(self._argv)}) stopped (exit code {code})."
        return PixatarError("cli-exited", f"{message}\n{said}" if said else message)

    def _stop(self) -> None:
        proc, self._proc = self._proc, None
        if proc is None:
            return
        try:
            if proc.stdin:
                proc.stdin.close()
            proc.wait(timeout=5)
        except (OSError, subprocess.TimeoutExpired):
            proc.kill()
            proc.wait()


_default: Optional[Pixatar] = None
_default_lock = threading.Lock()


def default_client() -> Pixatar:
    """The shared client the module-level functions use, made on first use (closed at exit)."""
    global _default
    with _default_lock:
        if _default is None:
            _default = Pixatar()
            atexit.register(_default.close)
        return _default


def avatar_png(seed: str, *, scale: int = 1, background: Optional[str] = None, text: bool = False) -> bytes:
    """:meth:`Pixatar.avatar_png` on the shared client."""
    return default_client().avatar_png(seed, scale=scale, background=background, text=text)


def sheet_png(seed: str, *, scale: int = 1, text: bool = False) -> bytes:
    """:meth:`Pixatar.sheet_png` on the shared client."""
    return default_client().sheet_png(seed, scale=scale, text=text)


def info(seed: str, *, background: Optional[str] = None, text: bool = False) -> Character:
    """:meth:`Pixatar.info` on the shared client."""
    return default_client().info(seed, background=background, text=text)
