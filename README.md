# Carry by SpaceMan

**Team:** LIM JUN DAO, RAMMJAYY A/L JAYAKUMAR, MURAKOSO YUJI, AHMAD ZARIF IMRAN BIN SHAHARUDIN

**Problem Statement:** Stress comes from students worrying about rejecting invitations from colleagues.

**Video Presentation:** [Unlisted Youtube Link]

**Presentation Slides:** [https://canva.link/xr2yfiex49c4gbj](https://canva.link/xr2yfiex49c4gbj)

## 1. Project Overview

**The Problem.** The majority of students somewhat won't know how much their workload is before accepting invites from friends, and it's hard to even detect burnout or near-burnout — an application like [Calm](https://www.calm.com/) doesn't help a student who is already near burnout or already burnt out. Calm offers a solution to burnout, but if someone is already stressed out, for what reason would they open the app and start meditating? This creates a burden on students to manually navigate a complicated system just to try to calm themselves down.

**Our Solution.** We offer a solution that helps students decide whether to accept an invite or not, with AI-prompted rejection drafting, plus games to relieve stress temporarily.

## 2. Ideation & Process

### 2.1 Ideas We Considered

Table of every distinct idea generated, with why each was kept or dropped, ordered so chosen ideas are listed first.

| Idea | Why it was dropped / kept |
|---|---|
| Social Load, Physical Load, Errands Load, Time Load, Mental Load | We dropped errand load because it's too much for our application — we believe users won't input their own personal life tasks into the app. Social, physical, and time load were kept so we could proceed with our other ideas. |
| Voting Peers System | Originated on day two with mentor Jarod Tan — Zarif said peers contribute the most to his stress, so we considered it since Jarod also recommended it. We dropped it because the idea has ethical issues that are hard to solve despite being unique. |
| Add a Health Record area | Dropped — not related to our target group (university students), and a health record area doesn't solve stress itself. |
| A legal rights section | Dropped — we're foundation students in computing with no prior legal knowledge. A wrong suggestion could create legal issues with the application. |
| Health Recommendation | Not fully dropped, but we were advised to keep the app to around 2 major solutions, otherwise it'd be too complicated and our UI/UX would confuse users. Still a must-have if we finish everything else on the list. |
| Skill Mastery (every progress visualised as a tree) / AI auto-creating tasks tailored to prevent burnout | A great idea, but it doesn't solve stress itself unless long-term, and it adds tasks to the user rather than removing burden — plus it might not match their actual university course. |
| Mental Support Section | Not fully dropped, but same complexity issue. Mentor Marcus Mah Qing Fung pointed out that an AI chatbot for mental support isn't compelling since people can just use ChatGPT instead — he suggested using AI for functions that save the user time (e.g. arranging a timetable) instead, to be added once the core app works. |
| Lecturer feedback | Dropped — we can't confirm a lecturer would act on the feedback, so it was too uncertain. |
| Details of what causes your stress the most | Not dropped, but not guaranteed to ship — most stress-manager apps have this, and it's a useful supporting function rather than the core solution. |
| A system that tracks deadlines, where the closer the deadline the more entertainment is restricted | Dropped — it became a burden to the team itself; if it doesn't relieve our own stress, it wouldn't relieve anyone else's. |
| Add bully/self-harm detection | Our worst idea — serious ethical issues, since it assumes someone is dangerous based on AI-analyzed chat history. |
| **Cost of Yes** — before accepting anything new, the app simulates the week after saying yes, showing load bars moving before you commit | **Kept as our main solution** — we observed that some university students struggle to manage time and workload from constantly getting invited to things. |
| **Say-no scripts** — the app drafts the actual decline message for you | **Kept** — pairs well with Cost of Yes. |
| Zero-input tracking | Something every team on this theme should ideally do, but hardware tracking is complex. We instead track the user's timetable (schedule, tasks, etc.) online rather than via hardware. |

### 2.2 Ideation Boards

[https://miro.com/app/board/uXjVHKpPaEg=/?share_link_id=351992160684](https://miro.com/app/board/uXjVHKpPaEg=/?share_link_id=351992160684)

### 2.3 Mentor Consultation

| Date | Mentor | Feedback Received | What Was Changed |
|---|---|---|---|
| 31 Aug 2026 | Khor Jia Quan | Focus on simple UI/UX design — be really simple that it was unique, reduce the number of clickable icons on the nav bar to a maximum of 5. Take Ryt Bank as a reference for simple and unique. | Changed the website style to Minimalist. Reduced confusing elements, nav bar down to 3-5 buttons. |
| 31 Aug 2026 | Jarod Tan | Focus more on solving problems than design. AI is necessary, like every hackathon, so try to implement it. Consider a student-focused angle since Zarif mentioned students as a major stress source. Skip hardware — too restricted for this hackathon's topic. | Added a Groq AI chatbot. Explored student rating and AI group formation, but dropped both over ethical concerns. Dropped the hardware idea. |
| 1 Sep 2026 | Teng Wei Herr | Also suggested simple, clean UI/UX design. | Already on track with simple UI/UX design. |
| 2 Sep 2026 | Mah Qing Fung | Suggested an engine that calculates task difficulty per individual using AI, and noted we had no "WOW" idea yet. | Gave up several ideas; eventually decided to build games instead. |
| 3 Sep 2026 | Jarod Tan | Approved our game idea. Said we could go all-in since it's about forming a solution — continue with a range of different game genres. | Implemented multiple mini-games into the project. |
| 4 Sep 2026 | Yeong Chiau Wen | Suggested the pitch should open with a story the judges can resonate with emotionally, then offer the solution. | Shaped the presentation narrative and flow around this advice. |
| 4 Sep 2026 | Sim Hong Bing | Told us to treat the rubric as king, follow it closely. Still a hackathon, so try new ideas. For the pitch, open dramatically since judges only have a short time per team (300+ groups competing). | Tweaked the website design heavily to fit rubric criteria, planned a full redesign, and clarified the presentation plan. |
| 5 Sep 2026 | Jarod Tan | Said the current design and product were already solid — keep going as-is. | Continued refining the design using all mentors' advice, aligned with rubric expectations. |

## 3. Design & Prototype

**UI Prototype:** [https://spaceman-lifestyle-stress-management.onrender.com](https://spaceman-lifestyle-stress-management.onrender.com)

*(Opens correctly in an incognito window.)*

## 4. What Makes It Different

| | Google Calendar / Notion | Headspace / Calm | Todoist | Carry |
|---|---|---|---|---|
| Shows your total load | ✗ just boxes | ✗ | ✗ no ceiling | ✓ one capacity number |
| Predicts stress from your schedule | ✗ | ✗ | ✗ | ✓ AI timetable read |
| Warns you before you commit | ✗ | ✗ | ✗ | ✓ Cost of Yes |
| Helps you say no | ✗ | ✗ | ✗ | ✓ schedule-based drafts |
| Quick stress relief | ✗ | ~ long sessions | ✗ | ✓ Pressure Valve |

**1. One number, not a list.**
Carry reduces your week to a single capacity number across mental, time, physical and social load — one thing to check instead of four separate mental calculations. *The twist:* calendars and to-do apps show items with no ceiling, so 40 tasks just feel heavy without ever saying whether you're actually over. Carry shows a total against a limit, peak-weighted so one brutal day counts for more than the same load spread across the week — no streaks, no guilt mechanics, just the number, there when you need it.

**2. Your timetable becomes the forecast.**
Upload your class and work timetable once, and the AI reads it to predict workload and stress per day and week — before a single invite even shows up. *The twist:* first-years have never run a 90% week before, so they can't recognise one coming, and working students can't renegotiate a fixed shift when a deadline slides onto it. Carry gives both groups a baseline from day one, with zero manual logging. The AI only reads and scores the timetable — it never edits it.

**3. Cost of Yes.**
This is the actual decision moment. Before you accept, Carry shows exactly how much your capacity would spike if you said yes — the bars moving from 70% to 95% in front of you. *The twist:* every existing tool accepts a new commitment silently. Carry gives you feedback at the one instant the decision is still reversible, instead of after you've already said yes and the week has already collapsed.

**4. Say-no drafts based on your real schedule.**
When yes would push you over, the AI drafts the actual decline message — pointing to a real deadline or shift already on your timetable, not a generic excuse. *The twist:* it's an honest reason, which matters most for working students who can't move a shift and often don't know how to turn down a group-mate or a manager without sounding like they're dodging.

**5. Pressure Valve — relief for after you've already said yes too many times.**
Calm and Headspace assume you have ten spare minutes — exactly what someone already near burnout doesn't have. Pressure Valve bets the opposite way: type what's stressing you, watch it appear on screen, then tap it apart into physics-driven shards in seconds. *The twist:* it's built for the moment you're already overwhelmed, not the moment you're trying to prevent it, and it runs on plain Canvas 2D so it stays fast on the same phone you're stress-checking between classes.

## 5. Technical Architecture & Feasibility

### Tech stack

**Full stack: Flask (Python), server-rendered with Jinja2, shipped as an installable PWA**

**Why:** The team knows Flask best, and building one server-rendered app (rather than a separate frontend/backend split) means one deployment, one codebase, and no CORS to manage — which matters when the team is newer to a split-stack setup and time is the scarcest resource in a hackathon. Every current feature (check-ins, capacity ring, commitments, voice-to-commitment, the mini-game suite) is a real Flask route and Jinja template today, not a mockup. The app already ships a web manifest and service worker, so it installs to a home screen and works as a PWA without needing a separate React build step.

**Constraints:** Full-page navigation reloads on most actions rather than a single-page app's instant transitions — acceptable for the current scope, but it's the main thing a future React rewrite would improve if the team advances and has runway to invest in it. Free-tier Supabase pauses the project after about a week of inactivity, so it needs to stay warm before judging.

### Database and Auth: Supabase (PostgreSQL)

**Why:** It's free, gives us Postgres plus built-in authentication in one place, and we've deployed with it before. Row Level Security means each student can only read their own commitments, check-ins, and stress data, which matters because this is sensitive wellbeing data.

**Constraints:** On the free tier, projects pause after about a week without activity, so we need to keep it active before judging. Storage is limited. RLS policies have to be written correctly or data leaks between users.

### AI: Groq API

**Why:** We first tested running Microsoft's Phi-3 locally (a script Yuji wrote), but that needs far more RAM than a free server has. Groq hosts open-source models, responds fast, and has a free tier, so the AI features can actually run in production.

**Constraints:** Free-tier rate limits, so we'll hit caps if many users test at once. It depends on a third party. The key is only ever read server-side, never exposed to the browser.

### Hosting: Render

**Why:** Free, deployed straight from GitHub, and we've used it before.

**Constraints:** Free web services go to sleep after about 15 minutes idle, so the first request after that can take a while to wake up. We'll warm it up before the demos. PWAs also require HTTPS, which Render provides by default.

### Design tools (optional to mention)

We used Figma (including its AI generator and FigJam for our ideation diagrams) and Stitch AI for layout exploration, so our time went into the problem definition and the capacity model rather than manual UI work. For the game animations we use plain Canvas 2D instead of a 3D library, to keep it light on phones.

### Build plan & scope

1. **Timetable-based stress predictor.** The user uploads or connects their class/work timetable. The AI reads the timetable and estimates workload and stress level per day/week — it does not modify or suggest changes to the timetable itself, only reads and scores it. This score feeds directly into the existing capacity formula (the same peak-weighted calculation behind the "Today" ring), so the timetable becomes a real input rather than a separate hidden feature.
2. **Cost of Yes, with AI-suggested rejection.** When the user is about to commit to something new, the app shows the projected capacity spike (Cost of Yes). Alongside this, the AI generates a suggested way to decline, based on the user's actual task schedule — for example, referencing a real deadline or class conflict already on their timetable, rather than a generic excuse.
3. **Pressure Valve game.** The short, re-enterable stress-release game already prototyped.

Out of scope for this phase: any AI-driven timetable rebalancing or automatic schedule changes, peer/social features, and a React/PWA rebuild beyond the current Flask implementation.
