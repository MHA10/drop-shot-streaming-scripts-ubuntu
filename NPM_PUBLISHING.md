# NPM Publishing Guide for streamer-node

This guide covers all the methods to publish this package to npm, from manual publishing to automated CI/CD workflows.

---

## Table of Contents

1. [Prerequisites](#prerequisites)
2. [Method 1: Manual Publishing](#method-1-manual-publishing)
3. [Method 2: GitHub Actions (Auto-increment)](#method-2-github-actions-auto-increment)
4. [Method 3: GitHub Actions (Release-based)](#method-3-github-actions-release-based)
5. [Method 4: GitHub Actions (Tag-based)](#method-4-github-actions-tag-based)
6. [Testing Before Publishing](#testing-before-publishing)
7. [Post-Publishing Tasks](#post-publishing-tasks)
8. [Troubleshooting](#troubleshooting)

---

## Prerequisites

### 1. npm Account Setup

1. Create an account at [npmjs.com](https://npmjs.com)
2. Verify your email address
3. (Optional) Enable 2FA for security

### 2. Generate npm Access Token

1. Login to [npmjs.com](https://npmjs.com)
2. Click your profile → **Access Tokens**
3. Click **Generate New Token** → **Automation**
4. Copy the token immediately (you won't see it again!)
5. Store it securely

### 3. Local Setup

```bash
# Login to npm (for manual publishing)
npm login

# Verify you're logged in
npm whoami
```

### 4. Verify package.json

Ensure these fields are set:

- `name` - unique package name
- `version` - starting version (e.g., "1.0.0")
- `main` - entry point (e.g., "dist/index.js")
- `types` - TypeScript declarations (e.g., "dist/index.d.ts")
- `repository` - GitHub repo URL
- `license` - License type
- `keywords` - Search keywords

---

## Method 1: Manual Publishing

**Use Case:** Full control, one-time publish, testing

### Step-by-Step Process

#### 1. Prepare Your Package

```bash
# Clean previous builds
npm run clean

# Install dependencies
npm install

# Build the project
npm run build

# Run tests
npm test
```

#### 2. Update Version

Choose the appropriate version bump:

```bash
# Patch release (1.0.0 → 1.0.1) - bug fixes
npm version patch

# Minor release (1.0.0 → 1.1.0) - new features
npm version minor

# Major release (1.0.0 → 2.0.0) - breaking changes
npm version major

# Or set specific version
npm version 1.2.3
```

This automatically:

- Updates `package.json`
- Creates a git commit
- Creates a git tag

#### 3. Test the Package Locally

```bash
# Create a tarball
npm pack

# This creates: streamer-node-1.0.0.tgz
# Test it in another directory:
# npm install /path/to/streamer-node-1.0.0.tgz
```

#### 4. Publish to npm

```bash
# Public package
npm publish --access public

# Scoped package (if name is @username/streamer-node)
npm publish --access public
```

#### 5. Push Changes to Git

```bash
git push origin master
git push --tags
```

### Advantages

✅ Full control over when to publish  
✅ Can test thoroughly before publishing  
✅ No CI/CD setup required

### Disadvantages

❌ Manual process, prone to human error  
❌ Can forget to update version  
❌ Not suitable for team collaboration

---

## Method 2: GitHub Actions (Auto-increment)

**Use Case:** Automatic publishing on every push to master

### Setup Process

#### 1. Add npm Token to GitHub Secrets

1. Go to your GitHub repository
2. Navigate to: **Settings** → **Secrets and variables** → **Actions**
3. Click **New repository secret**
4. Name: `NPM_AUTH_TOKEN`
5. Value: Paste your npm token
6. Click **Add secret**

#### 2. Create Workflow File

Create `.github/workflows/publish-package.yml`:

```yaml
name: "publish to npm"
on:
  push:
    branches:
      - master
jobs:
  publish:
    runs-on: ubuntu-latest
    steps:
      - name: checkout
        uses: actions/checkout@v3
        with:
          token: ${{ secrets.GITHUB_TOKEN }}
          fetch-depth: 0

      - name: setup node
        uses: actions/setup-node@v3
        with:
          node-version: 18
          registry-url: https://registry.npmjs.org

      - name: configure git
        run: |
          git config user.name "github-actions[bot]"
          git config user.email "github-actions[bot]@users.noreply.github.com"

      - name: bump version
        run: |
          npm version patch -m "Bump version to %s [skip ci]"
          git push --follow-tags

      - name: install dependencies
        run: npm ci

      - name: run tests
        run: npm test

      - name: build
        run: npm run build

      - name: publish
        run: npm publish --access public
        env:
          NODE_AUTH_TOKEN: ${{secrets.NPM_AUTH_TOKEN}}
```

#### 3. Development Workflow

```bash
# 1. Create feature branch
git checkout -b feature/new-feature

# 2. Make changes and commit
git add .
git commit -m "Add new feature"

# 3. Push to GitHub
git push origin feature/new-feature

# 4. Create Pull Request and merge to master

# 5. Automatic process triggers:
#    - Version bumps automatically (1.0.0 → 1.0.1)
#    - Tests run
#    - Package builds
#    - Publishes to npm
```

### Customizing Version Bump

To use minor or major bumps, modify the workflow:

```yaml
- name: bump version
  run: |
    # Check commit message for version bump type
    if [[ "${{ github.event.head_commit.message }}" =~ "[major]" ]]; then
      npm version major -m "Bump version to %s [skip ci]"
    elif [[ "${{ github.event.head_commit.message }}" =~ "[minor]" ]]; then
      npm version minor -m "Bump version to %s [skip ci]"
    else
      npm version patch -m "Bump version to %s [skip ci]"
    fi
    git push --follow-tags
```

Then commit with:

```bash
git commit -m "Add breaking change [major]"
git commit -m "Add new feature [minor]"
git commit -m "Fix bug"  # defaults to patch
```

### Advantages

✅ Fully automated  
✅ No manual steps required  
✅ Consistent versioning  
✅ Immediate publishing

### Disadvantages

❌ Every merge to master triggers publish  
❌ Less control over timing  
❌ Requires `[skip ci]` to prevent loops

---

## Method 3: GitHub Actions (Release-based)

**Use Case:** Manual control with automated publishing

### Setup Process

#### 1. Add npm Token (same as Method 2)

#### 2. Create Workflow File

Create `.github/workflows/publish-on-release.yml`:

```yaml
name: "publish to npm on release"
on:
  release:
    types: [published]

jobs:
  publish:
    runs-on: ubuntu-latest
    steps:
      - name: checkout
        uses: actions/checkout@v3

      - name: setup node
        uses: actions/setup-node@v3
        with:
          node-version: 18
          registry-url: https://registry.npmjs.org

      - name: install dependencies
        run: npm ci

      - name: run tests
        run: npm test

      - name: build
        run: npm run build

      - name: publish
        run: npm publish --access public
        env:
          NODE_AUTH_TOKEN: ${{secrets.NPM_AUTH_TOKEN}}
```

#### 3. Development Workflow

```bash
# 1. Make changes and commit
git add .
git commit -m "Add new feature"
git push

# 2. Update version locally
npm version minor  # or patch/major

# 3. Push with tags
git push --follow-tags

# 4. Create GitHub Release
#    - Go to GitHub → Releases → Draft a new release
#    - Choose the tag you just pushed
#    - Add release notes
#    - Click "Publish release"

# 5. Workflow automatically publishes to npm
```

### Using GitHub CLI

```bash
# Update version
npm version minor

# Push changes
git push --follow-tags

# Create release with GitHub CLI
gh release create v1.1.0 \
  --title "Release v1.1.0" \
  --notes "Added new streaming features"
```

### Advantages

✅ Full control over when to publish  
✅ Can add release notes  
✅ Clear versioning with releases  
✅ Good for production releases

### Disadvantages

❌ Requires manual version bumping  
❌ Extra step to create release  
❌ Can forget to create release

---

## Method 4: GitHub Actions (Tag-based)

**Use Case:** Publish on version tags only

### Setup Process

#### 1. Add npm Token (same as Method 2)

#### 2. Create Workflow File

Create `.github/workflows/publish-on-tag.yml`:

```yaml
name: "publish to npm on tag"
on:
  push:
    tags:
      - "v*.*.*"

jobs:
  publish:
    runs-on: ubuntu-latest
    steps:
      - name: checkout
        uses: actions/checkout@v3

      - name: setup node
        uses: actions/setup-node@v3
        with:
          node-version: 18
          registry-url: https://registry.npmjs.org

      - name: get version from tag
        id: tag_version
        run: echo "VERSION=${GITHUB_REF#refs/tags/v}" >> $GITHUB_OUTPUT

      - name: update package version
        run: |
          npm version ${{ steps.tag_version.outputs.VERSION }} --no-git-tag-version

      - name: install dependencies
        run: npm ci

      - name: run tests
        run: npm test

      - name: build
        run: npm run build

      - name: publish
        run: npm publish --access public
        env:
          NODE_AUTH_TOKEN: ${{secrets.NPM_AUTH_TOKEN}}
```

#### 3. Development Workflow

```bash
# 1. Make changes and commit
git add .
git commit -m "Add new feature"
git push

# 2. Create and push tag
git tag v1.2.0
git push origin v1.2.0

# 3. Workflow automatically publishes to npm
```

### Advantages

✅ Clean separation of code and releases  
✅ Explicit versioning with tags  
✅ Can tag any commit  
✅ Simple workflow

### Disadvantages

❌ Manual tag creation required  
❌ Must remember tag format (v1.2.3)  
❌ Package.json version not auto-updated

---

## Testing Before Publishing

### 1. Local Package Testing

```bash
# Build the package
npm run build

# Create a tarball
npm pack

# This creates: streamer-node-X.Y.Z.tgz
```

### 2. Test in Another Project

```bash
# In a different directory
mkdir test-project
cd test-project
npm init -y

# Install your local package
npm install /path/to/streamer-node-X.Y.Z.tgz

# Test it
node -e "const streamer = require('streamer-node'); console.log(streamer);"
```

### 3. Test as CLI Tool

```bash
# If your package has a bin field
npm link

# Now you can run
streamer-node --help
```

### 4. Dry Run Publishing

```bash
# See what would be published without actually publishing
npm publish --dry-run
```

---

## Post-Publishing Tasks

### 1. Verify Publication

```bash
# Check on npm registry
npm view streamer-node

# View specific version
npm view streamer-node@1.0.0

# Check your package page
# https://www.npmjs.com/package/streamer-node
```

### 2. Test Installation

```bash
# In a fresh directory
npx streamer-node@latest

# Or install
npm install streamer-node
```

### 3. Update Documentation

- Update README.md with new features
- Add CHANGELOG.md entry
- Update GitHub Release notes

### 4. Monitor Downloads

- Check npm package page for download stats
- Monitor GitHub issues for bug reports

---

## Troubleshooting

### Issue: "You cannot publish over the previously published versions"

**Cause:** Version already exists on npm

**Solution:**

```bash
# Update version
npm version patch

# Or manually edit package.json and bump version
```

### Issue: "403 Forbidden - npm publish"

**Cause:** Invalid or expired npm token

**Solution:**

1. Generate new token on npmjs.com
2. Update `NPM_AUTH_TOKEN` secret on GitHub
3. Or login locally: `npm login`

### Issue: "ENOENT: no such file or directory, open 'dist/index.js'"

**Cause:** Build not completed before publishing

**Solution:**

```bash
# Ensure build runs before publish
npm run clean
npm run build
npm publish
```

### Issue: Package name already taken

**Cause:** Package name is not unique

**Solution:**

- Use scoped package: `@username/streamer-node`
- Choose a different name
- Check availability: `npm view package-name`

### Issue: Workflow fails with "refusing to allow a GitHub App to create or update workflow"

**Cause:** Default `GITHUB_TOKEN` has limited permissions

**Solution:**

Add to workflow file:

```yaml
permissions:
  contents: write
```

Or create a Personal Access Token (PAT):

1. GitHub Settings → Developer settings → Personal access tokens
2. Generate new token with `repo` scope
3. Add as `GH_TOKEN` secret
4. Use in workflow: `token: ${{ secrets.GH_TOKEN }}`

### Issue: Tests fail in CI but pass locally

**Cause:** Environment differences

**Solution:**

```bash
# Check Node version matches
node --version

# Ensure clean install in CI
npm ci  # instead of npm install

# Check environment variables
```

### Issue: "npm ERR! need auth"

**Cause:** Not authenticated

**Solution:**

```bash
# Login to npm
npm login

# Verify authentication
npm whoami

# Check .npmrc
cat ~/.npmrc
```

---

## Best Practices

### 1. Semantic Versioning

- **MAJOR** (1.0.0 → 2.0.0): Breaking changes
- **MINOR** (1.0.0 → 1.1.0): New features, backward compatible
- **PATCH** (1.0.0 → 1.0.1): Bug fixes

### 2. Keep CHANGELOG.md

```markdown
# Changelog

## [1.1.0] - 2025-01-15

### Added

- New streaming feature X

### Fixed

- Bug in connection handling

## [1.0.0] - 2025-01-01

- Initial release
```

### 3. Tag Your Releases

```bash
git tag -a v1.0.0 -m "Release version 1.0.0"
git push --tags
```

### 4. Test Before Publishing

Always run:

```bash
npm run clean
npm install
npm test
npm run build
npm publish --dry-run
```

### 5. Use .npmignore

Exclude unnecessary files:

```
src/
tests/
*.test.ts
.env
coverage/
.github/
node_modules/
```

### 6. Security

- Enable 2FA on npm account
- Use automation tokens (not personal tokens)
- Rotate tokens regularly
- Never commit tokens to git

---

## Quick Reference

### Command Cheat Sheet

```bash
# Version bumping
npm version patch        # 1.0.0 → 1.0.1
npm version minor        # 1.0.0 → 1.1.0
npm version major        # 1.0.0 → 2.0.0

# Publishing
npm publish --access public
npm publish --dry-run    # Test without publishing

# Package management
npm pack                 # Create tarball
npm view streamer-node   # View package info
npm unpublish streamer-node@1.0.0  # Unpublish (72hrs only)
npm deprecate streamer-node@1.0.0 "reason"  # Deprecate version

# Authentication
npm login
npm whoami
npm logout

# Testing
npm link                 # Link package globally
npm unlink              # Unlink package
```

### Recommended Method

For most projects, **Method 3 (Release-based)** is recommended because it:

- Gives you full control
- Provides clear versioning
- Allows release notes
- Separates development from releases
- Works well with team collaboration

---

## Need Help?

- npm Documentation: https://docs.npmjs.com
- GitHub Actions: https://docs.github.com/en/actions
- Report issues: https://github.com/your-username/streamer-node/issues

---

**Last Updated:** October 2025  
**Package Version:** 1.0.0
