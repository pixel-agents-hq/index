"""The Python client against the real pixatar CLI (``$PIXATAR_CLI``, or ``pixatar`` on the
PATH). The pinned values are packages/pixatar/test/pinned.test.ts's: Python must get the very
bytes the JavaScript package makes."""

from __future__ import annotations

import hashlib
import json
import struct
import subprocess
import sys
from concurrent.futures import ThreadPoolExecutor

import pytest

import pixatar
from pixatar import Pixatar, PixatarError, find_cli

# text, its seed code, transparent seed code, background, md5 of avatar (scale 2), of the
# transparent avatar (scale 2) and of the sheet
TEXT_SEEDS = [
    (
        "octocat",
        "px.ASMByrHtCcOaAj1fXEBDyipVOErZBwFd2AE_HAZdVTbyDX2JAR3X5AldBTX_Cn2IAR3U-gBCXzgIdbQBurY",
        "px.ESMByrHtCcOaAj1fXEBDyipVOErZBwFd2AE_HAZdVTbyDX2JAR3X5AldBTX_Cn2IAR3U-gBCXzgIdbQBurY",
        "#a896e8",
        "f4d6ab10742d1e16f3639db4bad848f1",
        "1d16bbda5ce946cafd459e693106dc50",
        "07eb3d16b94164b21e1d182cc0997802",
    ),
    (
        "",
        "px.ASMBPUe_AXT3Aj0CPaDUsTrIpQC-BAZ9Dz_yJQp9IWH87wBCSHUIfQM1CQc",
        "px.ESMBPUe_AXT3Aj0CPaDUsTrIpQC-BAZ9Dz_yJQp9IWH87wBCSHUIfQM1CQc",
        "#c1eaa4",
        "cf6e29641e29ff9df55dcbe9acf4b47b",
        "19c3d3996e9a772f945f625ebb3f8c04",
        "b2309c60c1333a98a9e374e81e4d41de",
    ),
    (
        "\U0001f383",
        "px.ASMBNkGtA8OaAj1r1cilUi-2PQQGfRwm0QgKfYIBRfkBC32sAUUBAQh9ImP97g",
        "px.ESMBNkGtA8OaAj1r1cilUi-2PQQGfRwm0QgKfYIBRfkBC32sAUUBAQh9ImP97g",
        "#e2b9e4",
        "df26536f512a27977add1d4eec22e1dd",
        "73e7b47be3098c8eeae141e49253e6d1",
        "31aaabbad7eed4ce9e48d92f2773352c",
    ),
]

# seed codes made before the background flag, and their avatars (scale 2): these never change
CODE_AVATARS = {
    "px.ASMByrHvA3T3Aj0CPfFcyKV2swC-tj0FBn0dKu0BCV2CAUX3Cn2sAUX5AQt9VUUBAQh9iAEd1_g": "10f4d2f8b9fc1681fa2e1e0a68108a40",
    "px.ASMByrGtA8OaAj1fXD74dlK2PQQGXdQBNvIKeTYHCAtCLQYIfQM1CQc": "844b71bad4777ba79f97b451ba6ee258",
    "px.ASMBNkHvC3T3Aj0CPYUSQEPQe1IveFKfYAcGfQ8_8iUNddsCXV4JXZMCRfcKfQcCursLfdgCDCT6AEJfOAh9kwJF_AE": "ff6d6d01b8ed14468e4872783c43cc9b",
}

OCTOCAT = TEXT_SEEDS[0][1]


def md5(data: bytes) -> str:
    return hashlib.md5(data).hexdigest()


def png_size(png: bytes) -> tuple[int, int]:
    """A PNG's width and height, from its IHDR chunk."""
    assert png[:8] == b"\x89PNG\r\n\x1a\n" and png[12:16] == b"IHDR"
    return struct.unpack(">II", png[16:24])


@pytest.fixture(scope="module")
def px():
    with Pixatar() as client:
        yield client


@pytest.mark.parametrize("text,code,transparent,background,avatar,clear_avatar,sheet", TEXT_SEEDS)
def test_text_seeds_draw_what_javascript_draws(px, text, code, transparent, background, avatar, clear_avatar, sheet):
    character = px.info(text)
    assert character.seed == code
    assert character.background == background
    assert character.avatar_background == "color"
    assert px.info(text, background="transparent").seed == transparent

    assert md5(px.avatar_png(text, scale=2)) == avatar
    assert md5(px.avatar_png(code, scale=2)) == avatar
    assert md5(px.avatar_png(transparent, scale=2)) == clear_avatar
    assert md5(px.avatar_png(text, scale=2, background="transparent")) == clear_avatar
    assert md5(px.sheet_png(text)) == sheet
    # the transparent flag leaves the colour and the sheet alone
    assert px.info(transparent).background == background
    assert md5(px.sheet_png(transparent)) == sheet


@pytest.mark.parametrize("code,avatar", CODE_AVATARS.items())
def test_seed_codes_draw_the_avatars_they_always_did(px, code, avatar):
    assert md5(px.avatar_png(code, scale=2)) == avatar
    assert px.info(code).seed == code


def test_text_flag_reads_px_text_as_text(px):
    code = "px.ASMBP2e9A8OaAj2Ab7E6QEN2UnhSBAZd8AE28gp9ERAiIgtCN0QIfeMBHOTr"
    assert px.info("px.hello", text=True).seed == code
    assert md5(px.avatar_png("px.hello", text=True, scale=2)) == "e3c1319f93ba90a8d99d79ff433444a3"
    with pytest.raises(PixatarError) as e:
        px.info("px.hello")  # without the flag, a (bad) seed code
    assert e.value.code == "invalid-seed"


def test_sizes(px):
    assert png_size(px.avatar_png(OCTOCAT)) == (20, 20)
    assert png_size(px.avatar_png(OCTOCAT, scale=8)) == (160, 160)
    assert png_size(px.sheet_png(OCTOCAT)) == (128, 96)
    assert png_size(px.sheet_png(OCTOCAT, scale=3)) == (384, 288)


def test_profile_and_version(px):
    profile = px.info("octocat").profile
    assert isinstance(profile, dict) and profile["body"]
    version = px.version()
    assert version["vendor"]["version"]
    assert len(version["vendor"]["commit"]) == 40


def test_errors_carry_their_code_and_leave_the_client_working(px):
    cases = [
        (lambda: px.avatar_png("px.!"), "invalid-seed"),
        (lambda: px.avatar_png("octocat", scale=0), "invalid-request"),
        (lambda: px.avatar_png("octocat", scale=65), "invalid-request"),
        (lambda: px.avatar_png("octocat", background="blue"), "invalid-request"),
    ]
    for call, code in cases:
        with pytest.raises(PixatarError) as e:
            call()
        assert e.value.code == code
    assert px.info("octocat").seed == OCTOCAT


def test_threads_share_one_client(px):
    texts = [f"user-{i}" for i in range(40)]
    with ThreadPoolExecutor(max_workers=8) as pool:
        together = list(pool.map(lambda t: px.avatar_png(t, scale=2), texts))
    assert together == [px.avatar_png(t, scale=2) for t in texts]


def test_module_functions_use_a_shared_client():
    assert md5(pixatar.avatar_png("octocat", scale=2)) == TEXT_SEEDS[0][4]
    assert md5(pixatar.sheet_png("octocat")) == TEXT_SEEDS[0][6]
    assert pixatar.info("octocat").seed == OCTOCAT
    assert pixatar.default_client() is pixatar.default_client()


def test_a_closed_client_starts_again():
    client = Pixatar()
    first = client.avatar_png("octocat")
    client.close()
    assert client.avatar_png("octocat") == first
    client.close()


def test_one_shot_commands(tmp_path):
    cli = find_cli()
    png = subprocess.run(cli + ["avatar", "octocat", "--scale", "2"], capture_output=True, check=True).stdout
    assert md5(png) == TEXT_SEEDS[0][4]

    out = tmp_path / "sheet.png"
    subprocess.run(cli + ["sheet", "--out", str(out), "--", "octocat"], check=True)
    assert md5(out.read_bytes()) == TEXT_SEEDS[0][6]

    # a seed starting with a dash goes after --
    dashed = subprocess.run(cli + ["avatar", "--scale", "2", "--", "-x"], capture_output=True, check=True).stdout
    with Pixatar(cli) as client:
        assert dashed == client.avatar_png("-x", scale=2)

    info = json.loads(subprocess.run(cli + ["info", "octocat"], capture_output=True, check=True).stdout)
    assert info["seed"] == OCTOCAT

    bad = subprocess.run(cli + ["avatar", "px.!"], capture_output=True)
    assert bad.returncode == 1 and b"seed" in bad.stderr


def test_no_cli(monkeypatch):
    monkeypatch.delenv(pixatar.ENV_VAR, raising=False)
    monkeypatch.setenv("PATH", "")
    with pytest.raises(PixatarError) as e:
        Pixatar()
    assert e.value.code == "cli-not-found"
    with pytest.raises(PixatarError) as e:
        Pixatar(["/nonexistent/pixatar"]).version()
    assert e.value.code == "cli-not-found"


def test_a_cli_that_stops():
    client = Pixatar([sys.executable, "-c", "import sys; sys.stderr.write('boom'); sys.exit(3)"])
    with pytest.raises(PixatarError) as e:
        client.version()
    assert e.value.code == "cli-exited"
    assert "exit code 3" in e.value.message and "boom" in e.value.message
    client.close()


def test_command_from_the_environment(monkeypatch):
    monkeypatch.setenv(pixatar.ENV_VAR, "node 'some dir/cli.js'")
    assert find_cli() == ["node", "some dir/cli.js"]
    assert find_cli(["node", "x.js"]) == ["node", "x.js"]
