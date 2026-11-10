# Publishing Ritween to npm

The repository includes two GitHub Actions workflows:

- `ci.yml` validates pushes and pull requests on Node.js 22.18.0, latest 22, and 24.
- `publish.yml` stages a package when a GitHub Release is published, after checking the release version, unit tests, production build, and package contents.

Browser/GPU integration suites remain separate from CI because they require a compatible GPU and native codecs. Run the relevant suites locally for rendering and codec changes.

## One-time setup

1. Push this repository to GitHub. Use a public repository for the included provenance publishing configuration.
2. Add the real GitHub repository URL to `package.json` before publishing:

   ```sh
   npm pkg set repository.type=git repository.url=git+https://github.com/OWNER/REPOSITORY.git
   ```

   Replace `OWNER/REPOSITORY` with the actual destination. No Git remote was configured when these workflows were added, so the repository URL is intentionally not guessed.

3. Ensure you own the npm package name `ritween`. If it has never been published, create it with staged publishing from an authorized npm account:

   ```sh
   npm ci
   npm test
   npm run build
   npm pack --dry-run
   npm login
   npm stage publish --access public
   ```

   Complete npm authentication, then review and approve the staged package on npmjs.com with 2FA. If the name is unavailable, choose an owned package name and update package metadata, imports, and documentation before publishing.

4. On npmjs.com, open the package settings and configure a **Trusted Publisher**:

   | Setting                   | Value                                                                         |
   | ------------------------- | ----------------------------------------------------------------------------- |
   | Provider                  | GitHub Actions                                                                |
   | Organization or user      | Your actual GitHub owner                                                      |
   | Repository                | Your actual repository name                                                   |
   | Workflow filename         | `publish.yml`                                                                 |
   | Environment               | Leave empty; this workflow does not declare one                               |
   | Allowed actions, if shown | Leave direct `npm publish` unchecked; staged publishing is allowed by default |

The workflow uses GitHub-hosted runners, Node.js 24, npm 11, and `id-token: write`. It does not require an `NPM_TOKEN` secret. It stages the package; a maintainer must review and approve it on npmjs.com with 2FA before it becomes available to users. See [npm's trusted publishing documentation](https://docs.npmjs.com/trusted-publishers/) and [staged publishing documentation](https://docs.npmjs.com/staged-publishing/) for current requirements.

## Publish a release

Start from a clean working tree on your release branch:

```sh
# Updates package.json and package-lock.json, creates a commit and a v* tag.
npm version patch

# Push the release commit and its tag to your configured remote.
git push
git push --tags
```

Use `npm version minor` or `npm version major` as appropriate. Then create and **publish a GitHub Release** for the new tag, such as `v0.1.1`. Pushing a tag alone does not start the workflow. The workflow stages the package in npm; approve the staged package with 2FA to make it publicly available.

The workflow requires the tag to equal `v` plus the package version, with matching lockfile versions. A stable version stages with the `latest` dist-tag. A version such as `0.2.0-beta.0` must be marked as a GitHub prerelease and stages with `next`.

An npm package version can only be staged or published once. If the initial manual publish used `0.1.0`, release a higher version for the first automated staging run. If a workflow fails after staging succeeded, check npm's **Staged Packages** before rerunning it; attempting to stage the same version again will fail.

Inspect the **Publish to npm** run in GitHub Actions to confirm the package was staged. To stage an already-published GitHub Release again after a failed run, use **Actions → Publish to npm → Run workflow** on `main`, enter its tag (for example `v0.2.1`), and set the prerelease input to match the version. Then review and approve the staged package on npmjs.com with 2FA. The workflow does not deploy the Ritween website.
