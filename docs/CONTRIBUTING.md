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

**One-time setup — the `NPM_TOKEN` secret.** Publish requires an npm token
with write access to the `@hilbras` scope. Create it with:

```bash
npm token create --name github-actions \
  --scopes @hilbras \
  --packages-and-scopes-permission read-write \
  --expires 365
```

Then add the printed token under *Settings → Secrets and variables → Actions*
as `NPM_TOKEN`. The CLI prints the token **once** — copy it immediately.

Three properties matter, and two ways of creating a token get them wrong:

- **Scope it to `@hilbras`.** A token with write access to *all* packages
  (`--scopes` omitted) is over-privileged for CI: any workflow in the repo
  could publish under your whole npm account.
- **Do not bypass two-factor authentication.** npm refuses to *unpublish* with
  a token that has 2FA bypass enabled
  (`Granular access tokens that bypass two-factor authentication may not
  perform this action`). Since the scope is what makes the token safe, create
  it as a scoped granular token and leave 2FA bypass off.
- **Give it a long expiry and know when it ends.** A token that lapses makes
  the **Publish to npm** step fail with `ENEEDAUTH`; releases then need the
  manual fallback below. `npm token list` shows the expiry, and
  `npm token revoke <id>` removes one.

Without that secret, the gate steps pass but the **Publish to npm** step fails
with `ENEEDAUTH` and the release never publishes or creates a GitHub release.
In that case the fallback is to publish from a machine already logged in as a
publisher:

```bash
npm login
npm publish --access public      # from a clean tree at the release version
gh release create vX.Y.Z --title "..." --notes "..."
```

**If a version was published by mistake**, deprecate it rather than
unpublishing it — unpublishing is blocked for 2FA-bypassing tokens and, on
npm, is only possible within 72 hours of the publish:

```bash
npm deprecate @hilbras/omninode@X.Y.Z "Superseded by X.Y.Z-alpha.1, which carries …"
npm dist-tag add @hilbras/omninode@X.Y.Z-1 next    # move the fix to the prerelease channel
npm dist-tag add @hilbras/omninode@A.B.C latest    # put the last stable back on `latest`
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
