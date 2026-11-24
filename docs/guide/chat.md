---
title: Chat
parent: User guide
nav_order: 11.5
---
# Chat

The chat answers questions about the jobs in your tracker, in plain language, from any page. It looks your jobs up itself and answers only from what it finds. Questions it can answer:

- "Which Ready jobs do I have at Acme?"
- "What does the Example Corp posting say about remote work?"
- "How many jobs have I applied to?"
- "What did my tailored CV for the Example Corp role say about Python?"

If you allow it, it can also mark a job applied or add a note to a job when you ask it to.

## Opening the chat

The **Chat** button sits at the right end of the top bar on every page except sign-in and onboarding. It has two parts:

- **Chat** opens the chat panel, and closes it again.
- The arrow beside it lists **New chat** and your saved chats, the most recently used first, each with its date. Pick one to reopen it.

On a wide screen the panel sits beside the page, which narrows to make room. Drag the panel's left edge to make it wider or narrower, up to 70% of the window. On a phone the panel covers the page; close it with the **X** in its header.

Type a question in the box at the bottom and send it with Ctrl+Enter (Cmd+Enter on a Mac). While it works, a status line shows each lookup and what it looked at ("Searching jobs: Acme…", "Reading job: Data Engineer @ Acme…", "Marking applied: Data Engineer @ Acme"); a lookup that failed is marked **(failed)**. **Stop** cancels the answer, and so does closing or reloading the page while it runs. Stop shows only on the chat that is answering; while any answer runs, you cannot send another question. Earlier questions and answers in the same chat go along with each new question, so you can ask follow-ups; what the lookups returned is not kept, so the chat looks things up again when it needs the details.

The browser remembers the panel's width, whether it was open, and which chat was showing. The chats themselves are saved in the database, so they are there in any browser. Each chat is named after the first line of its first question. Each [user profile](configuration.md#user-profiles) has its own chats; when the remembered chat is not in the current one, the panel starts a new chat. A chat cannot be renamed or deleted.

## What it can look up

The chat uses the same tools as [Agent access](agent-access.md), but it does not need an agent token: the Agent access settings govern agents you run outside the app, never this chat.

| Lookup | What it gives the chat |
|---|---|
| Search jobs | A list of jobs matching a search, with a count, optionally narrowed to one status or to every job you ever applied to. |
| Read a job | One job: the posting and description, salary, deadline, fit verdict, applied date and LinkedIn live status. |
| A job's documents | Whether the job has a CV and cover letter PDF, and the cover letter text. |
| A job's tailored CV | Your CV as tailored for the job: each field with its tailored value, or the CV's own value where the job has none. |
| Your personal brief | Your [personal brief](cvs.md). The chat can always read it; the **Share the personal brief** switch in Agent access does not apply to it. |

The search is the in-app search: it matches one phrase at the start of words in the title, the employer or the location, the same way as [Searching every job](reviewing-jobs.md#searching-every-job), and does not search descriptions. So questions the tools cannot answer, such as counting or grouping jobs by source, by date or by location, get a plain answer that it cannot, or an approximation that says it is one.

## Letting it change jobs

The **Can change jobs** switch in the chat panel's header is off by default. It is one setting for all chats, and it cannot be flipped while an answer is running. With it off, the chat cannot change anything, and tells you so when you ask.

With it on, the chat can do two things, and only when you clearly ask:

| Change | What it does |
|---|---|
| Mark applied | Moves a **Ready** job to Applied and sets its [applied mark](job-lifecycle.md#the-permanent-applied-mark). It refuses a job in any other stage. |
| Add a note | Adds a note, with a title and text, to a job. |

The job list refreshes after a change. **A change the chat makes has no Undo.** You can move a job back with the **Stage** dropdown, but its applied date stays.

## What it costs

Every lookup step is a call to your **Tailoring Model**, the same model as tailoring and the ghostwriter (see [Which model does what](llm-providers.md#which-model-does-what)). A question takes at least one step and at most 8; a question that needs more stops with a message saying so. A call that fails on a passing error, such as a timeout, is tried once more, so a step can cost more than one call. Each call shows in the **LLM** call queue as "chat" with the chat's name (see [Watching calls](llm-providers.md#watching-calls)). A long chat makes each call bigger, because the earlier questions and answers go along with it.

The chat's instructions are a prompt like any other: edit **chat-assistant** in **Settings → LLM Prompts** (see [Editing the prompts](llm-providers.md#editing-the-prompts)).

How it works: [System overview: the chat](../architecture/system.md#the-chat)
