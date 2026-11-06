# Agent instructions

Applies to people and to every AI coding tool working in this repository (Claude, Codex, Cursor, Gemini and others). Repository-specific rules live in `CLAUDE.md` where one exists.

Never commit secrets or personal data: keys, tokens, passwords, phone numbers, Aadhaar or PAN numbers, real messages or exports.

## Commit record

Every commit message, from a person or any AI tool, ends with git trailers recording what was done and how it was checked:

```
Verified: <command you ran> -> <result you read>
Unverified: <what you only reasoned about, or "manual change">
```

Use at least one line, and both when both apply. The record says what was checked, never who or what wrote the change: no `Co-Authored-By`, "assisted by" or "generated with" lines. A commit guard checks this on commit and on push (warning until 2026-11-13, blocking after).
