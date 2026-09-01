# OIDC tagged npm publishing

## Problem

Publishing from a maintainer workstation requires interactive npm credentials and makes releases difficult to reproduce. Publishing on every `main` update is unsafe because npm versions are immutable and ordinary commits are not necessarily releases.

## Decision

Run `pnpm run check` for pull requests and `main` updates. Publish only when a `v*` tag is pushed, after verifying that the tag exactly matches `package.json#version` and points to a commit contained in `main`.

Authenticate `npm publish` through npm Trusted Publishing and GitHub Actions OIDC. The publish job receives only `contents: read` and `id-token: write`, uses a GitHub-hosted runner, disables package-manager caching, and stores no long-lived npm token. Third-party Actions are pinned to immutable commit SHAs.

## Alternatives considered

- Publish on every `main` push and automatically increment the version. This can release documentation-only or incomplete commits and obscures intentional versioning.
- Store an npm automation token in GitHub Secrets. This leaves a reusable credential that must be rotated and protected.
- Publish only from a maintainer workstation. This keeps an avoidable manual and non-reproducible release step.

## Consequences

- Maintainers still choose and commit each package version, then create the matching tag.
- A pushed release tag publishes automatically only after installation and the package `prepack` checks succeed.
- npm must be configured once with `hr98w/dsh-memory` and `publish.yml` as its trusted GitHub Actions publisher.
- Moving release automation to another workflow file requires updating the npm trusted-publisher configuration first.
