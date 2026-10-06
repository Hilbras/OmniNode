# Contributing

Thanks for improving OmniNode. The project is small and the gates are strict
on purpose: this is infrastructure that runs other people's agents.

## Development setup

```bash
git clone https://github.com/Hilbras/OmniNode.git
cd OmniNode
npm ci
npm test            # 446 tests, ~40 files
```

Requires Node.js 20+ (developed on 20/22/24; CI runs 20 and 22). No other
services are needed — integration tests spin up local HTTP servers and child
processes.

## The workflow

```
branch → implementation → tests → lint → typecheck → review → release
```

Every v2.0.x hardening release ships as its own tagged prerelease
(`v2.0.3-alpha.N`), so keep changes small, coherent and independently
releasable.

```bash
git switch -c feat/my-change
# … implement …
npm run verify     # lint + typecheck + test + build — the same gate CI runs
git commit -m "…"
git push -u origin feat/my-change
```

See [DEVELOPMENT.md](DEVELOPMENT.md) for the full local setup and
[EXTENDING.md](EXTENDING.md) for the extension guides (all samples there are
compiled against the public API).

## What a good change looks like here

- **Interfaces before implementations.** New capability = a new interface in
  `src/types` plus adapters, not core edits. Extension points: `IProvider`,
  `IAgent`/`IAgentAdapter`, `IPlanner`, `IMemoryProvider`, the store family,
  `AuditSink`.
- **One-way dependencies.** Adapters must not import engine modules; shared
  types live in `src/types`. Guard tests enforce this for the planner and the
  OmniHilbras provider.
- **Failures are data.** Errors carry codes and normalized details; the audit
  trail and diagnostics should explain a failure, not just report one.
- **No silent data loss.** Corrupt state is quarantined, secrets are refused,
  unknown configuration keys rejected, duplicates rejected.
- **Tests assert behavior.** For a new capability, add the failure mode too —
  see [TESTING.md](TESTING.md) and the failure matrix.

## Before you open a pull request

- [ ] `npm test` green
- [ ] `npm run lint` and `npm run typecheck` clean
- [ ] New/changed public API documented in [API.md](API.md) and
      [CHANGELOG.md](CHANGELOG.md) "Unreleased" spirit (just add your entry)
- [ ] User-visible behavior documented in [CLI.md](docs/CLI.md) or the relevant
      topic doc
- [ ] No secrets, tokens or personal paths in code or fixtures

## Releasing

Releases are tag-driven: pushing `vX.Y.Z` runs [release.yml](.github/workflows/release.yml),
which re-runs the full gate (lint, typecheck, tests, build) before publishing
to npm and creating the GitHub release. Prerelease tags (`vX.Y.Z-*`) publish
to the `next` tag; plain tags publish to `latest`.

**One-time setup — the `NPM_TOKEN` secret.** Publish requires an npm
automation token with publish access for the `@hilbras` scope:

1. Create an automation token in npm (*Access Tokens → Automation*, or an npm
   user for the `@hilbras` org).
2. Add it under *Settings → Secrets and variables → Actions* as `NPM_TOKEN`.

Without that secret, the gate steps pass but the **Publish to npm** step fails
with `ENEEDAUTH` and the release never publishes or creates a GitHub release.
In that case the fallback is to publish from a machine already logged in as a
publisher:

```bash
npm login
npm publish --access public      # from a clean tree at the release version
gh release create vX.Y.Z --title "..." --notes "..."
```

**Verify a release** from anywhere:

```bash
npm view @hilbras/omninode version dist-tags   # dist-tags.latest == vX.Y.Z
gh release view vX.Y.Z
```

See [ROADMAP_V3.md](ROADMAP_V3.md) (quick win B) for the plan to keep release
automation green end-to-end.

## Code of conduct

Be direct, be kind, assume good intent. Technical disagreement is settled by
evidence: a test, a benchmark, or a document.
