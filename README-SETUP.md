# Multi-agent web app kit for Claude Code
Copy these files into the root of your repository, then follow the setup steps from the chat.
Requires: Claude Code, git, jq (for the format hook).

.claude/agents/      9 specialist subagents (system prompts + tool limits + project memory)
.claude/skills/      /feature, /bug and /team-review workflows
.claude/settings.json  permissions, format hook, subagent wait behavior
CLAUDE.md            shared project brain loaded by every agent
*/CLAUDE.md          area conventions that load when an agent works in that folder
docs/                architecture, contracts, ADRs, threat model
Makefile + .github/  canonical commands and the CI that runs them
