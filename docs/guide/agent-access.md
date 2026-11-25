---
title: Agent access
parent: User guide
nav_order: 12
---
# Agent access

Agent access lets an AI agent you run yourself (Claude Code, Codex or any other MCP client) read your jobs, and, if you allow it, mark a job applied or add a note to it. The agent talks to the app over MCP, at `<app address>/mcp`, with a token you generate in Settings. Questions it can then answer:

- "Which of my jobs at Acme are tailored and waiting for me to apply?"
- "Read the Example Corp posting and my tailored CV for it, and draft answers to their application questions."
- "I just sent the application for the Example Corp role: mark it applied and note the recruiter's name."

Agent access is off until you generate a token.

## Turning it on

1. Open **Settings → Accounts & Security → Agent access**.
2. Press **Generate token**. The status changes to **On since** today's date.
3. Copy the token now: it is shown only this once. The box also shows the **Address** and a ready-made **Claude Code** command.
4. Pick the access level and whether to share the personal brief (below). A new token starts read only, with the brief not shared.

**Generate new token** replaces the token: the agent using the old one loses access, and access goes back to read only with the brief not shared. **Revoke** turns agent access off; the agent loses access at once.

## Connecting an agent

For Claude Code, copy the command the section shows. It has this shape:

```
claude mcp add --transport http cvclanker <app address>/mcp --header "Authorization: Bearer <token>"
```

Other MCP clients take the same address and the header `Authorization: Bearer <token>`, over the streamable HTTP transport. On the default setup the address is `http://localhost:3005/mcp`.

## What the agent can use

| Tool | What it gives the agent | Access needed |
|---|---|---|
| `search_jobs` | A list of jobs matching a search, each with its fit verdict, optionally narrowed to one status or to every job you ever applied to, and to jobs rated at least a given fit (for example Very good fit or better). | Read only |
| `get_job` | One job: the posting and description, salary, deadline, fit verdict and its reason, applied date and LinkedIn live status. | Read only |
| `get_job_documents` | The addresses of the job's CV and cover letter PDFs, when they exist, and the cover letter text. | Read only |
| `get_tailored_cv` | Your CV as tailored for the job: each field with its tailored value, or the CV's own value where the job has none. | Read only |
| `get_personal_brief` | Your [personal brief](cvs.md). | Read only, and **Share the personal brief** on |
| `mark_applied` | Moves a Ready job to Applied (the Live tab) and sets its [applied mark](job-lifecycle.md#the-permanent-applied-mark). | Read and change |
| `add_job_note` | Adds a note, with a title and text, to a job. | Read and change |

The built-in [chat](chat.md) has one more tool of its own, `ask_to_continue`, which it uses to ask you before it opens many jobs. It is not offered to agents.

## What each setting allows

| Setting | The agent can |
|---|---|
| **Read only** (the default) | Search and read jobs, their documents and tailored CVs. Any change is refused. |
| **Read and change** | Also mark a **Ready** job applied and add notes. It refuses to mark a job in any other stage. |
| **Share the personal brief** (off by default) | Read the personal brief. While it is off the agent cannot read the brief itself, at either access level; text written with it, such as the fit reason, the tailored CV and the cover letter, stays readable. |

Through agent access an agent cannot tailor, score or delete jobs, change settings, or read your API keys.

## Limits

- **Search is the in-app search.** It matches one phrase at word starts in the title, the employer or the location, the same way as [Searching every job](reviewing-jobs.md#searching-every-job); it does not search descriptions. Its status filters are the in-app `@` ones: ready, discovered, applied, in-progress, skipped and ever-applied.
- **Files.** `get_job_documents` returns paths such as `/pdfs/resume_<id>.pdf`; the agent fetches them from the app's own address, for example `http://localhost:3005/pdfs/resume_<id>.pdf`. Only the PDFs are listed.
- **One token per user profile.** The token belongs to the current [user profile](configuration.md#user-profiles), since each profile is its own database. After you switch profile the agent's token is refused: each profile has its own token, so give the agent the one generated in that profile.
- **Exports.** An export made without **Include API keys & secrets in exports** drops the token, so agent access is off after restoring it. An export with secrets carries the token and its settings.
- **An applied mark the agent sets cannot be undone from the app.** You can move the job back with the **Stage** dropdown, but its applied date stays.

## Without the web login

If the app runs without its web login, anyone who can reach its address can use the whole app, including generating a token here. The token limits only what the agent that has it can do. Turn the login on in Settings → Accounts & Access (**Enable authentication**), or set `BASIC_AUTH_USER` and `BASIC_AUTH_PASSWORD`; see [Authentication](configuration.md#authentication). The section shows the same warning while the login is off.

How it works: [System overview: the agent endpoint](../architecture/system.md#the-agent-endpoint)
