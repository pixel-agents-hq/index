# Publishing the avatar package

`@pixel-index/pixatar` is private for now (`"private": true` stops an accidental
`npm publish`), but it is kept ready to publish. CI's **Unit tests** job runs
`npm pack --dry-run --workspace @pixel-index/pixatar` on every PR, and the **Python avatar
client** job installs the CLI from that tarball, so the package that would ship is the one
that is tested.

Publishing it means pixel-index makes promises to projects outside this repo: a public
package name, semver, and seed codes that keep their characters. That's a decision of its
own, not a step in an unrelated PR. When it is made:

1. Decide the name and the npm account or org that owns it. The bin stays `pixatar`
   either way, so the CLI, `PIXATAR_CLI` and the Python client don't change. A scoped
   public package needs `"publishConfig": { "access": "public" }`.
2. In `packages/pixatar/package.json`, set `"version"` and remove `"private": true`. If
   the name changes, update the imports (`apps/web`'s dependency and its
   `@pixel-index/pixatar` imports), the tarball name in `.github/workflows/ci.yml`, and
   the install steps in [python/README.md](python/README.md).
3. Check what will ship: `npm pack --dry-run --workspace @pixel-index/pixatar`. It should
   list `dist/index.js`, `dist/index.d.ts`, `dist/cli.js` (the `pixatar` command), the
   source maps, `README.md`, `LICENSE`, `LICENSE-pixel-agents` (the bundled upstream's
   notice) and `package.json`.
4. Publish with `npm publish --workspace @pixel-index/pixatar`. `prepack` builds it, and
   the build bakes the pinned wardrobe in first. A tag-triggered workflow with an npm
   token is the durable way to do this, but it doesn't exist yet.

The published package has no runtime dependency on Pixel Agents: its sources and wardrobe
art are bundled into `dist/index.js`. Its only dependency is `fflate`.

## The Python client

`python/` isn't on PyPI. Projects install it from this repository (see
[python/README.md](python/README.md)). To publish it:

1. Publish the npm package first. The Python client runs its `pixatar` command, so the
   install steps should name a version that exists.
2. In `python/pyproject.toml`, set `"name"` (`pixatar` on PyPI, or another) and
   `"version"`. Keep it in step with the npm package, so a Python release names the CLI
   it was tested with.
3. In `python/README.md`, change the install steps to `npm install --global <name>` and
   `pip install <name>`.
4. Run `python -m build packages/pixatar/python`, then `twine upload packages/pixatar/python/dist/*`.
