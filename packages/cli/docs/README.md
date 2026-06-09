<!-- SPDX-License-Identifier: Apache-2.0 -->

# Lodestone Documentation Pack

This folder contains the friend-facing Lodestone documentation set.

Start here:

- [Feature brochure](./lodestone-feature-brochure.md) - plain-English overview, feature set, and comparison.
- [Installation guide](./lodestone-installation-guide.md) - step-by-step layperson instructions for the two install options.
- [Technical guide](./lodestone-technical-guide.md) - standard technical reference for operators and technical reviewers.

Word versions are generated into [word/](./word/).

HTML copies are included in [html/](./html/) and published at:

```text
https://lodestone.cmndi.ai/docs/
```

When Lodestone is installed from a package set that includes docs, the same
documentation is available in the target project at:

```text
./node_modules/@lodestone/cli/docs/
```

Build the full pack from the repository root:

```bash
pnpm docs:friend
```

The generated Word, HTML, and package-local copies are intentionally committed
because they are part of the friend distribution surface. For release rebuilds,
the packaging script sets stable metadata from the release commit. For a manual
reproducible rebuild, set `SOURCE_DATE_EPOCH` or
`LODESTONE_DOCS_BUILD_TIMESTAMP` before running `pnpm docs:friend`.
