# FULL CODE REVIEW

Review changes from the current task, fix issues, and present for smoketest. Do NOT commit — wait for explicit user approval after this process completes.

## Instructions

### Phase 1: Scope + Review

1. Identify which files YOU changed in this task (not all uncommitted changes). If the user also has uncommitted changes in other files, note them separately and exclude them from review.
2. Run `git diff` on only your files to see the full diff.
3. Launch a code review agent (Agent tool, subagent_type=general-purpose, model=sonnet) that:
   - Reads every changed file in full (not just the diff)
   - Reviews for: correctness, edge cases, consistency, test coverage, type safety, performance, security
   - Returns a numbered list of findings with severity (Critical, High, Medium, Low, Nit)
   - Is harsh and critical — flags anything questionable
   - Calls `voice_speak` MCP tool at the end with a summary

### Phase 2: Report

1. Use `voice_speak` MCP tool to announce a summary of findings.
2. Present the FULL findings table to the user:

| # | Severity | Finding | Action |
|---|----------|---------|--------|

For each finding, set Action to one of:
- **Fix** — You will fix this
- **Skip** — Genuinely not worth fixing

**Default to Fix. Be aggressive about fixing.** Your job is to leave the codebase better than you found it. If the reviewer found it, fix it. The bar for Skip is VERY HIGH — you should almost never skip.

Only skip if ALL of these are true:
- The fix requires a large refactor completely unrelated to the current change
- The fix risks regressions in untouched, unrelated code paths
- The issue has zero functional or quality impact

**ALWAYS fix (never skip):**
- Bugs, correctness issues, or edge cases — no matter how unlikely
- Hacks, timers, delays, or workarounds — even pre-existing ones in touched files
- Hardcoded values that should be dynamic
- Duplicated code/config that should be shared
- Inconsistencies in the pattern being implemented
- Bad patterns — even if they exist elsewhere in the codebase. Fix them here AND fix the other instances too. Don't perpetuate bad patterns just because they were used before.
- Dead code, unused variables, unreachable branches
- Anything that could cause bugs on different devices/screen sizes
- Security vulnerabilities (XSS, injection, unsafe URL handling)
- Anything that simplifies or improves the code — cleaner is always worth it

**Challenge the reviewer when you know better.** The review agent doesn't have full context — it reads code but doesn't understand the runtime behavior, platform quirks, or design decisions behind it. If a reviewer flags something that is actually correct, push back with evidence. Explain WHY it's correct. Don't blindly accept reviewer findings.

However: **fully investigate every finding before dismissing it.** Read the relevant code, check the claim, verify the edge case. If the reviewer is right — even partially — fix it. Don't dismiss findings just because they're inconvenient or would increase your diff.

The goal: ship clean code AND make correct decisions. Fix real issues aggressively. Defend correct code with evidence.

Explain your reasoning for each Skip — with specific evidence for why the reviewer's concern doesn't apply.

### Phase 3: Wait for Feedback

STOP and wait for the user to respond. They may:
- Approve your plan as-is
- Ask you to fix additional items
- Ask you to skip items you planned to fix
- Provide other feedback

Do NOT proceed until the user confirms.

### Phase 4: Fix

1. Apply all approved fixes
2. Run `npm run build` to verify the build passes
3. If build fails, diagnose and fix. If a second fix attempt fails, stop and report — do not loop endlessly.
4. Present a summary of what was fixed
5. Use `voice_speak` MCP tool to announce fixes applied.

### Phase 5: Smoketest

Present a manual test checklist based on the changes. For each changed behavior, list a concrete action the user should perform, e.g.:

> **Manual tests:**
> - [ ] Send a voice_speak command → should play audio and show in web UI
> - [ ] Queue 5+ messages → all should play in order, no errors
> - [ ] Click history item → full text shows in now-playing section
> - [ ] Press Space → pause/resume works
> - [ ] Check web UI at localhost:52719 → favicon is Pac-Man

Then tell the user: "Ready for your smoketest. Let me know when you're good to commit."

STOP. Do NOT commit. The user will tell you when to commit after testing.
