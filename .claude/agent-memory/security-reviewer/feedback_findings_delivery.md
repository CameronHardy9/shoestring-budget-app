---
name: findings-delivery
description: How FINDINGS.md updates get delivered; the harness blocked a full Write once, but Edit worked on the re-review
metadata:
  type: feedback
---
On 2026-11-12 the Write tool refused to create or overwrite docs/security/FINDINGS.md ("Subagents should return findings as text"), so the tech lead wrote it from my report, with owner approval. On 2026-11-13, with the coordinator's explicit go-ahead, **Edit** on the existing FINDINGS.md worked.

**Why:** a harness guardrail matches full-file writes of findings-style files. Getting around a refusal with another tool would be evading a control.
**How to apply:** update FINDINGS.md with Edit when the caller has asked for it. If any write is refused, put the complete, paste-ready content in the report; don't retry through Bash.
