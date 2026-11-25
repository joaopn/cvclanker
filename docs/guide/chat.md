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
- "What is the best-fitting job in Tailoring?"

If you allow it, it can also mark a job applied or add a note to a job when you ask it to.

## Opening the chat

The **Chat** button stays in the top right corner of the window on every page except sign-in and onboarding. It does not move when the chat panel opens or when you hide the top bar, so clicking it again in the same place closes the chat. It has two parts:

- **Chat** opens the chat panel, and closes it again.
- The arrow beside it opens a menu: first the **Can change jobs** switch (see [Letting it change jobs](#letting-it-change-jobs)), then **New chat** and your saved chats, the most recently used first, each with its date. Pick one to reopen it.

On a wide screen the panel sits beside the page, which narrows to make room. Drag the panel's left edge to make it wider or narrower, up to 70% of the window. On a phone the panel covers the page, and the same **Chat** button, still in the top right corner, closes it.

Type a question in the box at the bottom and press Enter to send it; Shift+Enter starts a new line. While it works, a status line shows each lookup and what it looked at ("Searching jobs: Acme…", "Reading job: Data Engineer @ Acme…", "Marking applied: Data Engineer @ Acme"); a lookup that failed is marked **(failed)**. **Stop** cancels the answer, and so does closing or reloading the page while it runs. Stop shows only on the chat that is answering; while any answer runs, you cannot send another question. Earlier questions and answers in the same chat go along with each new question, so you can ask follow-ups; what the lookups returned is not kept, so the chat looks things up again when it needs the details.

## Choosing the model

Under the question box sit two small menus. The first shows the provider and model the chat uses, such as "Claude Code · claude-opus-5". Open it and point at a provider to see its models, each labelled with the tasks it is set for. The models on offer are the ones already set for a task in [Which model does what](llm-providers.md#which-model-does-what): the Default, Scoring and Tailoring models under the main provider, and the pre-filter model under its own provider. When the pre-filter uses a provider that needs a key, it shows only once that key is saved. "CLI default" is a model left empty, which uses the provider's own default. The second menu, **Effort**, shows only for Claude Code: pick low, medium, high, xhigh or max, or **Default** to use the **Reasoning effort** setting (in **Settings → Models**, shown there when Claude Code is the main provider).

The choice is one setting for all chats and applies from the next question on. Until you pick one, the chat uses the Tailoring Model. Both menus are locked while an answer runs. If the model you picked stops being set for any task, or its provider's saved key is cleared, the chat goes back to the Tailoring Model.

The browser remembers the panel's width, whether it was open, and which chat was showing. The chats themselves are saved in the database, so they are there in any browser. Each chat is named after the first line of its first question. Each [user profile](configuration.md#user-profiles) has its own chats; when the remembered chat is not in the current one, the panel starts a new chat. A chat cannot be renamed or deleted.

## What it can look up

The chat uses the same tools as [Agent access](agent-access.md), but it does not need an agent token: the Agent access settings govern agents you run outside the app, never this chat.

| Lookup | What it gives the chat |
|---|---|
| Search jobs | A list of jobs matching a search, with a count and each job's fit verdict, optionally narrowed to one status or to every job you ever applied to, and to jobs rated at least a given fit. |
| Read a job | One job: the posting and description, salary, deadline, fit verdict and its reason, applied date and LinkedIn live status. |
| A job's documents | Whether the job has a CV and cover letter PDF, and the cover letter text. |
| A job's tailored CV | Your CV as tailored for the job: each field with its tailored value, or the CV's own value where the job has none. |
| Your personal brief | Your [personal brief](cvs.md). The chat can always read it; the **Share the personal brief** switch in Agent access does not apply to it. |

The search is the in-app search: it matches one phrase at the start of words in the title, the employer or the location, the same way as [Searching every job](reviewing-jobs.md#searching-every-job), and does not search descriptions. The chat knows the app's tab names (Inbox, Tailoring, Live, Interviewing, Backlog, Stale, Closed) and the fit verdicts, so you can ask about "my Tailoring jobs" or "jobs rated Very good fit". For a question that needs several lookups it chains them: for example, to find the best-fitting job in Tailoring it lists the Ready jobs with the better verdicts, lists the better-rated jobs in processing (being tailored, or waiting to retry a failed tailor), reads the most promising of them, and ranks them. A search returns at most 200 jobs; when a search matches more than the chat got back, it is told to search again for more, or more narrowly, or to say that its list is incomplete. It says it cannot answer only when no series of lookups can, and says so when an answer is an approximation.

## When it asks before going on

Reading a job puts its whole text into the conversation, which makes every later step bigger, slower and more expensive. So the chat is told to stop and ask before reading more than 10 jobs for one question, saying how many jobs it would read and why, with **Continue** and **Cancel** buttons. This is an instruction to the model, not a hard limit, so a model may still read more without asking. **Continue** lets it go ahead. **Cancel** leaves it there; you can then ask a narrower question, such as one about fewer jobs or a single employer.

## Letting it change jobs

The **Can change jobs** switch, the first entry in the menu under the arrow beside the **Chat** button, is off by default. Flipping it leaves the menu open. It is one setting for all chats, and it cannot be flipped while an answer is running. With it off, the chat cannot change anything, and tells you so when you ask.

With it on, the chat can do two things, and only when you clearly ask:

| Change | What it does |
|---|---|
| Mark applied | Moves a **Ready** job to Applied and sets its [applied mark](job-lifecycle.md#the-permanent-applied-mark). It refuses a job in any other stage. |
| Add a note | Adds a note, with a title and text, to a job. |

The job list refreshes after a change. **A change the chat makes has no Undo.** You can move a job back with the **Stage** dropdown, but its applied date stays.

## What it costs

Every lookup step is a call to the model chosen under the question box, your **Tailoring Model** until you pick another (see [Choosing the model](#choosing-the-model)). A question takes at least one step and at most 8; a question that needs more stops with a message saying so. A call that fails on a passing error, such as a timeout, is tried once more, so a step can cost more than one call. Each call shows in the **LLM** call queue as "chat" with the chat's name (see [Watching calls](llm-providers.md#watching-calls)). A long chat makes each call bigger, because the earlier questions and answers go along with it.

The chat's instructions are a prompt like any other: edit **chat-assistant** in **Settings → LLM Prompts** (see [Editing the prompts](llm-providers.md#editing-the-prompts)).

How it works: [System overview: the chat](../architecture/system.md#the-chat)
