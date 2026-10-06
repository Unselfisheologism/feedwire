# Publish Feedwire from your phone

Feedwire **0.1.0** is already on npm and PyPI. Future releases use GitHub Actions
Trusted Publishing (OIDC), without stored npm or PyPI API tokens.

Preparing or committing files does not publish them. Publishing a non-draft,
non-prerelease GitHub Release triggers `.github/workflows/publish.yml`.
There is no push or manual-dispatch publishing trigger.

## Trusted publishers (one-time setup)

Use your phone browser; enable Desktop site if a settings control is hidden.
Sign in to npm and PyPI as the account that owns the existing `feedwire` package.
Configure both publishers before making the next release.

### npm

1. On npmjs.com, open your packages, select **feedwire**, then **Settings**.
2. Under **Trusted publishing**, choose **Add trusted publisher** and **GitHub Actions**.
3. Enter these exact, case-sensitive values:
   - **Organization or user:** `Unselfisheologism`
   - **Repository:** `feedwire`
   - **Workflow filename:** `publish.yml` (not `.github/workflows/publish.yml`)
   - **Environment name:** leave blank. The workflow does not use a GitHub environment.
4. In **Allowed actions**, allow direct **npm publish**. Stage-only permission is
   not enough for this workflow. Dist-tag management permission is not needed.
5. Save. npm does not validate the settings when saved; double-check all fields.

The publishing job uses GitHub-hosted Ubuntu, Node 24 and npm 11 (at least 11.5.1).
npm requires Node 22.14.0 or newer for Trusted Publishing. It detects OIDC
credentials automatically and generates provenance; no `NODE_AUTH_TOKEN` or
`--provenance` flag is needed. This does not change the package's Node requirement.

### PyPI

1. On pypi.org, open **Your projects > feedwire > Manage > Publishing**.
2. Under **Add a new publisher**, select **GitHub** and enter:
   - **Owner:** `Unselfisheologism`
   - **Repository name:** `feedwire`
   - **Workflow name:** `publish.yml` (filename only)
   - **Environment name:** leave blank. The workflow does not use a GitHub environment.
3. Tap **Add** and confirm the publisher appears in the list.

This is an existing project, so do not create a pending publisher or a new project.
The upload uses `pypa/gh-action-pypi-publish@release/v1` with job-level
`id-token: write` and no username, password or API-token inputs.

Neither publishing job uses a GitHub environment. PyPI recommends environments
for additional protection, but they are optional. If one is added later, its
exact name must also be configured in the corresponding trusted publisher.

### Remove old tokens

After both trusted publisher configurations are saved:

1. In GitHub's Feedwire repository, open **Settings > Secrets and variables >
   Actions** and delete `NPM_API_TOKEN` and `PYPI_API_TOKEN`. This workflow no longer
   reads either secret and has no token fallback.
2. Revoke the old publishing tokens in npm **Access Tokens** and PyPI **Account
   settings > API tokens** if they are no longer used elsewhere. Deleting a
   GitHub secret alone does not revoke the token at the registry.
3. npm also recommends **Settings > Publishing access > Require two-factor
   authentication and disallow tokens > Update Package Settings**. OIDC still
   works with this setting. Its migration guide recommends verifying a real
   OIDC release before enabling this extra restriction.

Never paste tokens into messages or repository files. No new tokens are needed.
Saving a trusted publisher proves only that its configuration was stored; actual
OIDC authentication is verified by the next approved release, not by ordinary CI.

## Next release

1. Update both `node/package.json` and `python/pyproject.toml` to the same new
   version and refresh `node/package-lock.json`. Never reuse published `0.1.0`.
2. Commit the changes, then wait for green CI and approval to publish.
3. Open the repository **Releases** page and tap **Draft a new release**.
4. Choose a matching new tag, for example `v0.1.1` only if both versions are
   `0.1.1`. Choose **Create new tag on publish** with **Target: main**. The tag
   must include the Trusted Publishing workflow change, not an older commit.
5. Add a title and release notes. Leave **Set as a pre-release** unchecked.
   Tap **Publish release** only when ready to upload both public packages.
   Saving a draft does not upload anything.
6. Open **Actions > Publish packages**. The build job checks the release tag,
   package versions and assets, runs both test suites, packs npm and builds/checks
   the Python distributions. Only the two upload jobs have OIDC permissions.
7. Confirm the new version is visible on both registries before announcing it.

## Failed uploads

If one upload fails, check the job log and the corresponding trusted publisher:
owner, repository, filename, environment and (for npm) direct publish permission.
For npm, also check npm >=11.5.1, Node >=22.14.0 and `id-token: write`. Do not
solve an OIDC error by adding a token.

Use **Re-run failed jobs** only after checking that the failed upload did not
already reach the registry. Do not rerun a successful upload; registries reject
reusing versions. Report a one-registry success as partial. Rerunning the old
`v0.1.0` workflow uses its old commit and is not a test of this migration.

## References

- https://docs.npmjs.com/trusted-publishers/
- https://docs.pypi.org/trusted-publishers/adding-a-publisher/
- https://docs.pypi.org/trusted-publishers/using-a-publisher/
