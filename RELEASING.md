# Publish Feedwire from your phone

Both packages are version **0.1.0**. The first release tag is **v0.1.0**.
Preparing or committing files does not publish them. Publishing a non-draft,
non-prerelease GitHub Release triggers `.github/workflows/publish.yml`.

## Secrets (one-time setup)

In the Feedwire repository, open **Settings > Secrets and variables > Actions**.
Use **New repository secret**, not the Variables tab:

- `NPM_API_TOKEN`: an npm granular token with **Read and write (publish and stage)**
  package permissions and **Bypass two-factor authentication** enabled for CI.
  For the first unscoped package, it needs permission to create `feedwire`;
  use All Packages if a not-yet-created package cannot be selected. Give it a
  short expiry. After the first upload, replace it with a package-scoped token.
- `PYPI_API_TOKEN`: a PyPI token scoped to **Entire account** for the first upload.
  After the project exists, replace it with a token scoped only to `feedwire`.

Enter tokens only into GitHub's secret boxes, never messages or repository files.
GitHub cannot show their values afterward. Their presence does not prove validity.

## First release

1. Wait until the package-prep commit on `main` has green CI and publishing is approved.
2. Open the repository **Releases** page in your phone browser. Tap **Draft a new release**.
3. Choose **Choose a tag**, type `v0.1.0`, then choose **Create new tag: v0.1.0 on publish**.
4. Keep **Target: main**. Title: `Feedwire v0.1.0`. Add release notes if wanted.
5. Leave **Set as a pre-release** unchecked. Tap **Publish release** only when ready
   to upload both public packages. Saving a draft does not start uploads.
6. Open **Actions > Publish packages**. The build job checks the versions, runs both
   test suites, packs npm, builds the Python wheel/source distribution, and checks metadata.
   Then the `npm` and `pypi` jobs upload independently.
7. Verify both registries show `feedwire` version `0.1.0` before announcing
   `npm install feedwire` and `pip install feedwire` as available.

If one upload fails, read that job's error, fix its secret or permission, and use
**Re-run failed jobs**. Do not re-run the successful upload: registries reject
reusing a published version. If only one registry succeeded, report it as partial.
Package names are not reserved by an availability check; first upload may still
be refused because of ownership, restrictions, or a name taken in the meantime.

## Later releases

Update the version in both `node/package.json` and `python/pyproject.toml`, and
refresh `node/package-lock.json`. Commit those changes, wait for CI, then publish
a matching stable tag (for example `v0.1.1`). Never reuse a published version.

## Token references

- https://docs.npmjs.com/creating-and-viewing-access-tokens
- https://docs.npmjs.com/using-private-packages-in-a-ci-cd-workflow
- https://pypi.org/help/#apitoken
