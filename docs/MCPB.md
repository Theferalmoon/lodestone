<!-- SPDX-License-Identifier: Apache-2.0 -->

# Claude Desktop MCPB Packaging

Lodestone can be packaged as a private Claude Desktop MCPB bundle for users who
prefer a one-click desktop install over editing MCP JSON by hand.

Use this path when:

- the user already has Claude Desktop;
- the target project already ran `lodestone init` and `lodestone reindex`;
- the operator wants a local-only MCP server with no remote telemetry;
- the bundle will be built on the same operating system family where it will be
  installed.

Do not use this path as a replacement for the friend installer. The public
installer remains the simplest way to install Lodestone into a repo and build
the local index.

## Build

Build a private bundle for the current platform:

```bash
scripts/mcpb/build-claude-desktop-bundle.mjs --profile lite
```

The default output directory is ignored by Git:

```text
dist/mcpb/
```

The full profile is also available:

```bash
scripts/mcpb/build-claude-desktop-bundle.mjs --profile full
```

The packer creates a current-platform artifact because Lodestone includes
native Node dependencies. Build separate bundles on separate target platforms.
During packaging, it prunes non-current ONNX Runtime binaries and obvious GPU
provider libraries from the bundled `node_modules` tree.

For a fast structural smoke that does not include `node_modules`:

```bash
scripts/mcpb/build-claude-desktop-bundle.mjs --manifest-only --out-dir /tmp/lodestone-mcpb-smoke
```

Manifest-only artifacts are not distribution-ready.

## Install In Claude Desktop

1. Open Claude Desktop.
2. Go to Settings, then Extensions.
3. Install the generated `.mcpb` file.
4. When Claude asks for the Project folder, select the repository where
   Lodestone is already initialized.
5. Start a new Claude Desktop conversation for that project and ask Claude to
   use Lodestone's MCP tools.

The selected project must contain:

```text
.lodestone/lodestone.toml
.lodestone/ready.json
```

If the project is not ready, run:

```bash
lodestone init
lodestone reindex
lodestone status
```

## How It Works

The MCPB manifest asks Claude Desktop for one setting: `Project folder`.

At launch time, the bundle:

1. reads the selected folder from `LODESTONE_REPO_ROOT`;
2. verifies that `.lodestone/lodestone.toml` exists;
3. changes the process working directory to that project;
4. starts the bundled `@lodestone/mcp-server` over stdio.

This keeps Lodestone local to the user's machine. The MCP server reads the
selected project's local `.lodestone/` index and does not contact CMNDI.

## Cleanup

The packer removes temporary staging directories automatically. The only
intentional output is the `.mcpb` artifact under `dist/mcpb/` or the directory
passed with `--out-dir`.

Delete old local artifacts when they are no longer needed:

```bash
rm -rf dist/mcpb
```

Do not commit generated `.mcpb` files to the repository.
