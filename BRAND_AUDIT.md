# Edge Seeker Brand Audit Checklist

## Approved Brand Names
- App: "Edge Seeker" (two words, title case)
- Agent: "EDGESEEKER" (all caps, AI agent identity only)
- Domain: "edgeseeker.sol" (always lowercase)
- Social: "@EdgeSeekerSOL"
- Admin: "Edge Seeker Admin"

## Never Use
- EdgeSKR
- EDGESKR
- EdgeSKR
- edgeskr (except in legacy URLs/GitHub which cannot be changed)

## Audit Command for Claude Code
Run this audit any time new code is added:
1. Search all .html and .js files for "EdgeSKR" (case insensitive)
2. Search for "EDGESKR"
3. Search for "@EdgeSKR" or "@EdgeSeeker" (correct is "@EdgeSeekerSOL")
4. Report all instances with file name and line number
5. Fix all instances following the approved brand names above
6. Exception: variable names, comments, and GitHub URLs do not need changing

## Notes
- GitHub repo name (edgeskrapp-jpg) cannot be changed without breaking deployments
- Vercel project URL (edge-seeker.vercel.app) stays as is
- Internal variable names (REVENUE_WALLET etc) stay as is
- Only fix user-facing text, UI labels, and social references
