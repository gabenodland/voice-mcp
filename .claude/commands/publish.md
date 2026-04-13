# PUBLISH TO NPM

Bump version, build, publish, commit, and push. Run this when changes are ready to ship.

## Instructions

### Phase 1: Pre-flight checks

1. Run `npm whoami` to verify npm login
2. Run `git status` to ensure working tree is clean (no uncommitted changes)
   - If dirty: STOP and tell the user to commit or stash first
3. Run `npm run build` to verify build passes
   - If build fails: STOP and report the error

### Phase 2: Version bump

1. Ask the user what kind of bump: patch, minor, or major
   - Default to **patch** if they just say "publish" without specifying
   - patch: bug fixes, small improvements
   - minor: new features, non-breaking changes
   - major: breaking changes
2. Run `npm version <bump> -w packages/mcp-server --no-git-tag-version` to bump the version
3. Read the new version from `packages/mcp-server/package.json`

### Phase 3: Build and publish

1. Run `npm run build` (rebuild with new version)
2. Run `cd packages/mcp-server && npm publish --access public`
   - If this fails due to 2FA: tell the user to run the publish command manually from their terminal
   - If it fails for other reasons: STOP and report
3. Use `voice_speak` MCP tool to announce: "Published version X.Y.Z to npm"

### Phase 4: Commit and push

1. Stage the version bump: `git add packages/mcp-server/package.json package-lock.json`
2. Commit: `git commit -m "release: voice-tts-mcp vX.Y.Z"`
3. Create a git tag: `git tag vX.Y.Z`
4. Push: `git push && git push --tags`
5. Use `voice_speak` MCP tool to announce: "Pushed to GitHub with tag vX.Y.Z"

### Phase 5: Verify

1. Run `npm view voice-tts-mcp version` to confirm the published version
2. Report the published version and npm URL to the user:
   - npm: https://www.npmjs.com/package/voice-tts-mcp
   - Install: `npx -y voice-tts-mcp`
