# Running a recruitment cycle

For whoever is running applications this semester. You do not need to have used
this tool before, and you do not need to know anything about how it works.

Everything below is one full cycle, in order, from the application export to the
final list of new Sparklets.

**Practise first.** There is a training file, `prisma/fixtures/demo-cycle.csv`,
with 25 invented applicants in it. Import it as its own cycle and click all the
way through. Nothing in it is real, so nothing you do to it matters. This guide's
screenshots come from exactly that file, so what you see should match.

There is also a finished cycle called **Demo Cycle (finished — for reference)**.
When a screen does not look the way you expect, open that one to see what it
looks like when it is done.

---

## Before you start

You need two things from whoever ran it last:

- **The app password.** Gets you into the tool at all.
- Nothing else. You will create this cycle's own password yourself, in step 1.

Sign in at `/login`. It asks for your **first and last name** as well as the
password.

> **Your name is not a password and is not checked.** Anyone with the app
> password can type anything. It is there so that when someone changes a score
> or reverses a decision, the record says who — the whole club shares one
> password, so without a name every change reads as "an admin". Type your real
> name.

---

## 1. Create the cycle and upload the file

**Instances → New instance.**

![Creating a cycle from the application export](docs/img/01-new-instance.jpg)

Three things:

- **Instance name** — how this cycle appears in the list. "F26 Recruitment" or
  similar.
- **Instance password** — you are choosing this now, and it is separate from the
  app password. Share it with the other admins on this cycle. **It cannot be
  recovered.** If everyone forgets it, an admin with the app password can reset
  it from Settings, but nobody can read it back.
- **The application export**, as a `.csv`.

> **A cycle accepts exactly one file, and importing is final.** If the file turns
> out to be wrong, the fix is to delete the whole cycle and start again — which
> is quick, as long as you notice before people start scoring. That is what the
> next two steps are for.

---

## 2. Say what each column means

Nothing has been created yet. This screen is you telling the tool how to read the
file, and you can change anything on it until you commit.

![The column mapping screen](docs/img/02-mapping.jpg)

The banner at the top lists what still needs doing before you can continue. Work
down it.

Each column is three rows of controls, in the order the questions actually come:

1. **What is this column** — its display name, and whether it is the email or
   name column.
2. **What kind of thing is it, and who sees it** — category, include, and the
   two visibility checkboxes.
3. **Is it part of a bigger question** — its group, and its role in that group.

Grouping reads last because it *overrides* the two rows above it: category,
inclusion and visibility are set on the group and apply to every column in it.

> The screenshot above is from a cycle that has already committed, which is why
> its display names, designations, categories and grouping are greyed. On a fresh
> import every one of those is editable — only include and the visibility choice
> stay editable afterwards.

### Detected groups

Some questions arrive as several columns rather than one. Ethnicity is the usual
case: ten separate columns, any number of which an applicant may tick.

The tool notices columns that look like one question and offers them as a
**group**. This is a suggestion, not a decision — nothing is stored until you
name it.

**Name it `Ethnicity` and press Create group.** Ten columns become one question,
which is what makes the demographic breakdowns later add up to the number of
people rather than the number of boxes ticked.

> If you see **more than one** group offered where you expected one — say, three
> separate clusters of ethnicity columns — that means some of those columns are
> empty for every applicant in the file. An empty column has nothing to
> recognise. It is usually harmless in a real export, where every option gets
> ticked by somebody.

### The write-in column

Ethnicity usually has a free-text "specify your own" column beside the ten. **The
tool will not find this one for you** — its values are different for every
person, so there is nothing to recognise.

Add it by hand: find that column in the table below, set its **group** to
`Ethnicity`, then set its role to **write-in (not counted)**.

> That last part matters. Left as "option (counted)", one person's typed answer
> becomes its own category in every breakdown for the rest of the cycle.

### The group's settings

Set **Category** to `Demographics`. The visibility checkboxes beside it will
lock themselves to **Backend only**, greyed out, reading *"locked: demographics
are never shown (§6)"* — that is the tool enforcing the club's own rule that
reviewers do not see ethnicity. You cannot turn it off, and that is deliberate:
the rule is the system's job, not something you have to remember.

> This applies to **all three rounds**, including second-round deliberation.
> Ethnicity is an admin statistic — you see it on the results and composition
> screens — and it never reaches a reviewer.

Category, inclusion and visibility are set on the *group* and apply to all
eleven columns, so a group cannot end up half hidden and half visible.

### The two required designations

Further down, in the columns table:

- **Email Address** → designation **Email column**. This is how later imports
  find the right person, so it is not optional.
- **First Name** and **Last Name** → designation **Name column** (both of them).

### Categories

Every column starts as **Other**. The tool never guesses from the header text —
guessing is how a demographic column ends up visible to reviewers.

**Set every essay question to `Responses`.** These are what reviewers read.

Leave the administrative columns (timestamps, response type, network ID) as
Other.

Category says what a column *is*. It no longer says who sees it — that is the
next section, and it is a separate decision.

### Who sees each column

Every column has two checkboxes: **Reviewer-visible** and **Backend only**. They
are mutually exclusive.

- **Reviewer-visible** — every reviewer sees it, in all three rounds.
- **Backend only** — no reviewer sees it, in any round. You still see it.

**Nothing is ticked to begin with, with one exception.** The moment you set a
column's category to `Responses`, it ticks **Reviewer-visible** for you. That is
not the tool guessing: an essay that reviewers cannot read is refused at commit
anyway (see the note at the end of this section), so Reviewer-visible was the
only answer you were ever going to be allowed to give. Ticking it saves you the
click rather than deciding anything.

For **Other** and **Demographics** it still refuses to choose, because for those
both answers are real and mean different things.

You can override it. Tick **Backend only** on a Responses column and it will
stay ticked — and the commit will then refuse, which is the point.

Work down the table and answer for each remaining column. A column you have not
answered shows **not set** in amber, and the banner at the top counts them.

![Columns with visibility set, and one still unanswered](docs/img/02b-column-visibility.jpg)

> **You cannot commit until every column has an answer.** This is a hard stop,
> not a warning. Demographic columns and excluded columns are not counted —
> their answer is already decided for them.

The same list appears on a cycle that has **already** committed, if a column
somehow ends up without an answer. Nothing is blocked at that point — the
applicants exist and the cycle runs — but those columns stay hidden from every
reviewer until you decide, so the screen says so rather than leaving you to
notice.

![A committed cycle with one column still unanswered](docs/img/02c-visibility-outstanding.jpg)

What to tick, in practice: **the essays Reviewer-visible**, the administrative
columns (timestamps, network ID, tags) **Backend only**. The judgement calls are
things like major, minor and graduation year — reviewers can see them if the
club wants that, and it is a one-click change later if you get it wrong.

> **The essays are the one answer the tool argues with.** If you mark a column
> `Responses` and then set it Backend only, the commit is refused. Marking
> something a Response is saying it is what reviewers read, so hiding it is
> almost always a mis-click. If you genuinely want it hidden, change its
> category or un-include it.

---

## 3. Check the preview, then commit

**Preview and commit →**

![The import preview](docs/img/03-preview.jpg)

This is the last point at which a bad file is cheap to fix. Three kinds of thing
appear here.

**Things that stop you committing.** The two most common come straight from step
2:

> *3 columns have no visibility set. Choose Reviewer-visible or Backend only for
> each on the columns screen.*

> *2 Response columns are set to Backend only. Reviewers would not see the
> essays.*

Both mean going back to step 2 and finishing the table. Neither can be dismissed
— that is the point of them. The count tells you how many are left.

**Worth checking** — things that are probably wrong but might be deliberate.
These do not block you:

> *No column is categorised as a Response. Nothing marks the essays, so reviewer
> profiles will show only whatever Other columns you set to Reviewer-visible.*

That one is a warning rather than a stop, because an application built entirely
from short-answer Other columns is unusual but not wrong.

**Problems in the file itself** — two applicants sharing an email address, a
blank name, an address with spaces around it. Each is listed with the rows
involved, and you resolve them here. A clean file says so:

> *No duplicates, blank names, blank addresses, or padded addresses.*

When both sections are clear, press **Commit**. Applicants are created and the
column mapping is fixed from here on.

> Some things stay editable after committing: whether a column is included, and
> whether reviewers can see it. What a column *means* — its category, its group,
> its name — does not.

Committing takes you through one more screen that spells out exactly what becomes
permanent. Read it rather than clicking past it.

![The commit confirmation](docs/img/04-commit-confirm.jpg)

---

## 4. Build the scoring rubric

**Rubric**, from the cycle's page.

![Building the written round rubric](docs/img/05-rubric.jpg)

This is what a written reviewer scores each applicant against. Nothing assumes a
particular number of categories or a particular scale — both change between
cycles, and both are yours to set.

For each category: a **name**, a **lowest** and **highest** score, and then one
line per score under **What each score means**. A 1–4 category gives you four
boxes; change the range and the boxes follow it.

**Write them.** They appear above the reviewer's score buttons, and they are the
difference between thirty people scoring the same thing and thirty people scoring
thirty things. A category used to take one paragraph describing itself, which
sounds like the same thing and is not: the paragraph said what the category was
*about* and left every reviewer to invent privately where a 2 stopped and a 3
began. **The boundaries are where reviewers actually disagree**, and they are what
FR-10's variance column ends up reporting two steps later.

Each line is optional and an empty one simply renders nothing — but a category
with no lines at all is a name and some buttons, which is the state this replaced.

> **Write the middle ones, not just the ends.** "A 4 did X, a 1 did nothing" is
> the easy half and leaves the two scores most applicants get undefined.

> A very wide scale cannot carry per-score guidance — the screen says so and asks
> you to narrow the range. Ten values is the limit, and a rubric wider than that
> is almost always a typo rather than a plan.

> Once anyone has scored an applicant, the rubric locks — names, ranges and these
> lines alike. You cannot add a category halfway through a round and leave the
> earlier scores meaning something different from the later ones.

---

## 5. Add the reviewers

**Reviewers.** Three tabs across the top, one per round. The rounds have separate
rosters, and **everyone starts on the written round**.

![The reviewer roster](docs/img/06-reviewers.jpg)

**Paste the names**, one per line, straight from the Slack thread or the sign-up
sheet. Press *Check this paste* first: it tells you how many are ready, how many
need confirming, and how many blank lines it ignored, before anything is created.

It splits each line at the **last space**, so "Mary Anne Chen" becomes Mary Anne
/ Chen. Anything it cannot split, and anything matching someone already on the
roster, is held back for you to confirm rather than guessed at — re-pasting the
same Slack message is the likeliest accident, and it will not silently create
everyone twice.

### Staffing the later rounds

**On the First round and Second round tabs there is nothing to type into.** No
add form, no paste box — just the code, a line explaining why, and the grid.

![The first-round tab: no add form, only the grid](docs/img/06b-reviewers-later-round.jpg)

**Tick the round's column in the grid** to put someone on it. Every row has all
three, so one person's three rounds are one row and one set of ticks.

Two things follow from that, and both are the point of it:

- **Holding a later round requires holding the earlier ones.** First round
  requires written; second round requires both. Tick one out of order and that
  row refuses, saying which round is missing. Somebody deliberating in the second
  round without having read a single application is deliberating without the
  evidence the earlier rounds produced.
- **One human is one row.** Typing "Alex Kim" into a first-round box was the last
  way left to create a *second* Alex Kim — same person, two roster rows, two
  half-finished sets of assignments. There is no box to type it into now.

If you genuinely need someone on the first round who did not do the written round
— a new officer, someone who joined late — put them on **written** first. They do
not have to be assigned any applicants there.

> **The rule is checked when you tick, not held forever.** Removing someone from
> the written round while they still hold the first round is allowed, and leaves
> a row that could not have been created that way. If a roster looks impossible,
> that is how. Put them back on written, or take the later round off first.

### Sparklets

Tick **Sparklet** for existing Spark SC members. This matters more than it looks:
**at most one Sparklet reviews any given applicant**, so this count decides
whether assignment is possible at all. The roster summary shows it.

### The access code

Each round has its own code, and reviewers need it to sign in. Set one, then send
**the link and the code together** — the link alone is not enough, and the code
alone is useless.

---

## 6. Assign applicants to reviewers

**Assignments.**

![Assignment, after generating](docs/img/07-assignments.jpg)

The panel at the top is the arithmetic, before you commit to anything:

| | |
|---|---|
| **Slots in the full grid** | applicants × reviewers each |
| **Held open as the pool** | about 5% of slots, kept free |
| **Applicants at full strength** / **one short** | how the pool is spread |
| **Load per reviewer** | a spread wider than one means the roster constrained it |

Press **Generate assignments**. In the practice cycle that reads:

> *Placed 72 assignments. 3 applicants are one reviewer short, by design.*

### Why some applicants are one reviewer short

The pool is a **conflict-of-interest buffer**, not an oversight. A reviewer who
knows an applicant returns that slot, and any other reviewer can claim an open
one. Spreading the gap across several applicants — each starting with one
reviewer fewer — means a slow-moving pool costs an applicant *one* opinion rather
than all three, which is what would happen if whole applicants were held back
unassigned.

### If it refuses to generate

It will tell you why, and it is almost always the Sparklet rule: too many
Sparklets on the roster for every applicant to get at most one. Add non-Sparklet
reviewers, or take some off this round.

### Changing an assignment by hand

You can **assign**, **unassign**, **swap** or **return to pool** any individual
pairing, and each change is recorded with your name against it. **Regenerating
keeps manual changes** — it works around them rather than discarding them — but
it will tell you how many it is carrying before you confirm.

**Unassign and Return to pool are not the same thing**, and picking the wrong one
is the mistake worth avoiding here:

| | Use it when | What happens |
|---|---|---|
| **Unassign** | the pairing was a mistake | the pairing is deleted, **any scores go with it**, and regenerating may pair them again |
| **Return to pool** | the reviewer is not coming back | their scores stay, the slot opens for anyone to claim, and regenerating will **never** pair them again |

The second is the one you want for a reviewer who has gone quiet: it is the same
thing the reviewer's own **Return to pool** does, written the same way, so it
lands in the same pool that **Claim from pool** draws from. Doing it for them is
the only difference.

It asks you to confirm, and it **requires a note** — "no reply on Slack for two
weeks". A reviewer returning a slot themselves picks a reason from a list, which
explains itself; an admin return is always "other", so the note is the entire
record of why. It goes to the audit log with your name.

> **Regenerating will never re-create that pairing.** That is the point of it
> rather than a side effect — a reviewer who has stopped responding should not be
> handed the same applicant again by the next generation. If you do want them
> back on that applicant, assign them by hand; that reactivates the slot and the
> scores are still there.

---

## The cycle's home page

Every screen from here is reached from the cycle's own page, and it doubles as a
progress report — each row says where that piece stands.

![The cycle hub, part-way through](docs/img/00-hub.jpg)

Rows greyed out are waiting on something earlier. They are in roughly the order a
cycle uses them.

---

## 7. The written round

Reviewers do this part. You send them the link and the code, and watch.

### What a reviewer sees

**Not the applicant's name.** Written reviewers see "Applicant 11" and whatever
you marked Reviewer-visible in step 2 — the essays, and anything else you ticked.
Not the name, not the email, and never ethnicity. That is deliberate and it is
enforced by the tool, not by people remembering.

The name and email rule is specific to this round: reviewers see both from the
first round onwards. The ethnicity rule is not — it holds in every round.

They score against your rubric, reading **your line for each score value** above
the buttons, and scores **save as they tap** — there is no submit button to
forget. This is where step 4's writing does its work: what you wrote for a 3 is
what stands between thirty people scoring the same thing and thirty people
scoring thirty things.

They also get one checkbox per applicant: **This looks AI-written to me.** It is
their own read, no other reviewer sees it, and it reaches you and nobody else —
on the results table's **AI?** column and on the applicant's page. See step 8.

### The pool

A reviewer who recognises an applicant presses **Return to pool** and gives a
reason. That slot becomes claimable by anyone else, from **Claim from pool** at
the top of their list. This is why some applicants started one reviewer short:
that gap is the buffer those returns land in.

---

> ## About the screenshots from here on
>
> Steps 1–7 were photographed while importing the 25-applicant training file, so
> what you see is what you get.
>
> **This step and everything after it are photographed at full size instead** —
> 158 applicants, 30 reviewers, 7 new Sparklets. A composition panel over 25
> people, and an AI column nobody has ticked, show the layout and none of the
> point; and getting a practice cycle as far as step 12 by hand would mean twelve
> people signing in to vote and two interview spreadsheets to build, which is not
> a reasonable thing to ask of someone learning the tool. The reference cycle
> exists already finished for that reason.
>
> **Your numbers will be much smaller than the ones in these pictures.** A
> first-round list of 8 rather than 48 is not a sign you have done something
> wrong. The screens are the same; only the scale differs.

---

## 8. Written results, and closing the round

**Written results.**

![The results table](docs/img/08c-results-table.jpg)

The table ranks everyone by average score, with **variance** beside it — a high
variance means reviewers disagreed, which is worth a second look before you cut
someone. **Reviews** shows how many of the three are in; anyone under 3/3 is
marked.

Above the table: **Incomplete** narrows to the applicants still short a review,
**Variance at least** takes a number, and **Clear filters** puts it all back.
Every filter is in the address bar, so a filtered table is a link you can send
someone.

### The AI? column

A flag and a number — **⚑ 2** — is **how many reviewers ticked "this looks
AI-written to me"** on their own copy of that application. A dash means nobody
did.

**It is a count, not a fraction, and hovering gives you the denominator** —
*"2 of 3 completed reviews thought the writing looked AI-generated."* The
denominator is completed reviews rather than assigned ones, because a reviewer
who has not read the application has not declined to flag it.

> **Nothing is decided by this, and nothing detected it.** It is the manual
> column the club already kept in the spreadsheet, moved into the tool. Three
> reviewers disagreeing about one application is the signal it exists for — a 1
> is one person's read, a 3 is worth reading the application yourself.

Reviewers cannot see it, and neither can the second round. Open the applicant to
see **which** reviewers ticked it; the count on the row deliberately does not say.

### Ethnicity in the table

Multi-select answers **wrap onto two lines** rather than being cut off with an
ellipsis. An applicant who ticked three options used to read as *"Black, Middle
Eastern…"* with the rest reachable only by hovering, which on a phone or a
trackpad-less laptop meant not at all.

### The composition panel

Tick the applicants who advance. As you do, the **composition panel** at the top
updates live: your selection against the whole pool.

![The composition panel, mid-selection](docs/img/08-results.jpg)

Two columns: **Selected** and **Pool**. Each is a fraction over *its own* size —
`0.5/6` against six selected, `9.0/158` against the whole cohort — so the two are
directly comparable without doing any arithmetic in your head.

Every row now prints the denominator it is counted against:

- **Ethnicity and other multi-select questions** read `9.0/158 (12)` — a weighted
  9.0 out of the 158-applicant pool, ticked by 12 people.
- **First-generation, pronouns, and anything else with one answer each** read
  plainly: `Yes 45/158`, `No 113/158`. There is no bracketed count because it
  would repeat the number in front of it.

> **The weighted number is the club's counting rule, and the denominator is what
> makes it readable.** Someone who selected three options contributes a third to
> each, so the weighted column sums to the number of *people* — 158 here, the
> number now printed beside every row. The bracketed number counts every person
> who ticked that option, and those add up to more than 158, which is correct and
> is why both are shown. Somebody who answered nothing is a whole person under
> **Not specified**.

> Every value gets its own line, in order. The tool is not told which answer
> means yes — guessing that out of a CSV is exactly the inference it refuses to
> make about categories back in step 2.

**It is there to be looked at while you choose, not audited afterwards.**

### An applicant's own page

Click any name for the full picture: every review with the reviewer's name on it,
their per-category scores, their note, and their AI flag if they set one.

![One applicant's reviews](docs/img/08b-applicant-profile.jpg)

**← Back to results** returns you to the table — with your filters still on,
which the breadcrumb above it does not do. The breadcrumb goes to the cycle's
home page; this goes back where you came from.

### Finalising

**Finalize written round** shows you exactly what is about to happen, and it
checks your work:

> *8 applicants advance to the first round. 17 applicants are rejected. Every
> applicant gets a written-round decision recorded, either way. This screen
> becomes read-only afterwards.*

If you are about to reject anyone nobody actually reviewed, it names them:

> *17 of those 17 have no completed reviews… **Rejecting them records a decision
> nobody made.** Claim-from-pool is how they still get read.*

**Take that seriously.** In a real cycle it means reviewing is not finished —
chase the outstanding reviews, or have someone claim those applicants from the
pool, before you finalise. The tool will let you proceed, because sometimes you
genuinely are out of time, but it will not let you do it without knowing.

Finalising writes a decision for **every** applicant, advancing or rejecting, and
the screen becomes read-only.

---

## 9. Set up the interview rubric

**Interview rubric.**

![The first round interview rubric](docs/img/09-interview-rubric.jpg)

Interviews are scored on their own categories, separate from the written rubric —
a different instrument, scored at a different time by different people. Nothing
assumes a particular number of them.

**Do this before the interviews happen**, because the scores spreadsheet needs
**one column per category**, and the people running interviews need to know what
they are scoring against.

Once scores are imported the rubric locks, and the screen says so:

> *Interview scores have been imported — 384 category scores across the cohort.
> The rubric is locked. Changing it now would leave those scores measured against
> categories that no longer exist.*

If you genuinely got the categories wrong, **Discard imported scores** unlocks it
and you import again.

---

## 10. Import the interview results

**Interview import.**

![The two interview sheets](docs/img/10-interview-import.jpg)

Two separate sheets, uploaded independently — neither waits for the other, and
either can be re-uploaded to correct it.

- **First round scores** — one row per interviewer per applicant: who they are,
  who interviewed them, one column per interview category, and the average.
- **First round notes** — one row per applicant: who they are, optionally who
  wrote the notes, and the notes themselves.

### Matching people up

This is the step most likely to need your attention, and the one the tool is
most careful about. Each row is matched to an applicant by **email first**, then
by exact name, then by close name. Anything it cannot resolve confidently goes
into a queue for you to decide, rather than being guessed.

> **It will not guess between two plausible people.** If a row could be either of
> two applicants, it asks. If a name is close to exactly one applicant, it still
> asks before committing — a nickname is often less similar to someone's real
> name than two different people's names are to each other, so "close enough" is
> not a decision the tool is willing to make on its own.

Fix the unresolved rows before moving on. A row left unmatched is an interview
that happened and does not count.

---

## 11. The first-round vote and its results

Reviewers on the first round read the interview scores and notes and vote yes or
no on each applicant. Their list is a way of **finding** people — it carries a
search box and nothing to vote with; the vote is on the applicant's own page,
under the evidence. **First round results** ranks the outcome.

![First round results](docs/img/11-first-round-results.jpg)

Ranked by **yes percentage, skips excluded** — someone who recused themselves is
not counted in either the top or the bottom of that fraction, so a recusal does
not quietly drag an applicant down. The **Votes** column shows the actual
fraction, which is what tells you whether a percentage is meaningful: 100% of 16
votes and 100% of 2 votes are not the same fact.

Select who advances and finalise, exactly as in step 8. Afterwards the page
stays as a read-only record:

> *The first round has been finalized. These results stay here for reference.*

### Show only who moved on

Once a round is finalised, both results pages grow a **Moved on** button above
the table. Press it and the table narrows to the people who advanced, with the
count beside it — *"30 of 48 advanced to the second round"*.

It is the answer to "who is actually in the next round", which before meant
reading a list of 48 and remembering which ticks you had made an hour ago. It
appears **only after finalising**, because until then nobody has moved on and the
button would empty the table.

The written results page has the same button, on the same terms.

---

## 12. The second round: passes

**Second round.**

![Two closed passes](docs/img/12-passes.jpg)

The second round is deliberation rather than scoring. Everyone still active is
discussed and voted on together, in one or more **passes**.

**Membership is fixed when the pass is created** — whoever is still active at
that moment. Each applicant in a pass resolves one of three ways:

| Outcome | Meaning |
|---|---|
| **Unanimous yes** | becomes a Sparklet |
| **Unanimous no** | rejected |
| **Anything mixed** | carried forward into the next pass |

That is why there is more than one pass: the summary above reads *"6 sparklet · 5
rejected · 16 carried"* on pass 1, and pass 2 opens with those carried applicants
plus anyone still unresolved.

Open a pass and the grid **colours its outcomes** — green for a new Sparklet, red
for a rejection, and nothing for carried or needs-an-admin, which are not
outcomes yet.

> **Each pass's grid shows what happened in that pass**, not where the applicant
> ended up. Someone carried by pass 1 and admitted in pass 2 stays uncoloured on
> pass 1's grid. That is the pass being a record of a sitting rather than a live
> status board.

### What the room can see

Second-round reviewers see **the same red and green**, on their list and on each
profile: this applicant is now a Sparklet, this one was rejected. Everyone who
reached the round stays on their list for the whole of it — nobody vanishes when
they are decided.

**They still never see votes.** Not a tally, not a count, not who voted which
way, in any pass, open or closed. You are the only person who sees those, here.

> That is a deliberate trade and worth knowing about, because it cuts both ways.
> An applicant resolves only when everyone eligible has voted, so a green badge
> does tell the last person to vote how the others voted. It was accepted because
> the second round is one room in one sitting where the outcome is said out loud
> anyway, and because the alternative — people silently disappearing off the list
> — left reviewers unable to tell what had happened to someone they had just
> spent ten minutes arguing about.

### Conflicts of interest

A reviewer flags a conflict on an applicant and stops voting on them for the rest
of the round — the flag is sticky across every pass, not just the current one.
Their absence counts as a skip, not as a no.

**If every reviewer has recused from someone, that is not unanimity.** The tool
marks them as needing an admin rather than reading an empty tally as a decision.

### Rejecting someone by hand, and undoing it

Below the grid, **Reject an applicant** removes someone from this and every later
pass without a vote — use it when the room has decided and waiting for eleven
submissions is theatre. It asks you to confirm, and names the person with their
applicant number, because names repeat.

If you rejected the wrong person, **Reverse a rejection** on the same page puts
them back, **as long as the pass is still open** — once it closes, nothing in it
can be changed. Only a rejection you made by hand can be reversed; one decided
by a unanimous no cannot. Both actions are recorded in Activity with your name.

### Closing

Closing the second round marks everyone still undecided as needing an admin, and
**cannot be reopened**. You resolve those yourself on the next screen.

---

## 13. The final class, and the export

**Final class.**

![The finished class](docs/img/13-final-class.jpg)

Three groups: **New Sparklets**, **Rejected**, and **Unresolved** — the people
the passes never decided, either because reviewers never reached unanimity or
because everyone had recused.

Unresolved applicants are admitted or rejected **here, on this screen**, and
their votes stay visible while you decide. That matters: eleven skips and a 7–4
split both arrive as "unresolved", and they mean completely different things.

Below the three groups is the **demographic breakdown of the class against each
preceding stage** — who applied, who reached the first round, who reached the
second, and who got in. This is the number the club actually wants at the end of
a cycle, and it replaces the spreadsheet that used to be maintained by hand.

### Export, and please actually do it

**Export** gives you the whole cycle as one JSON file, plus per-stage CSVs
(all applicants with scores, decisions by stage, the final class with emails).

> **Do this at the end of every cycle and put the file somewhere the club keeps
> things.** It is the club's insurance against this tool: everything is in that
> file, in a format anything can read, so nobody is ever locked in. It is also
> what you would restore from if something went badly wrong.

The JSON contains the instance password hash and the round access codes, so treat
it like the sensitive file it is.

---

## When a cycle is over

Nothing else is required. The cycle stays where it is, readable, in full, for as
long as the club wants it. Nothing expires, nothing is cleaned up on a schedule,
and no essay, email or demographic answer is ever deleted by the system.

If you do need a cycle gone, **Delete instance** on that cycle's Settings page is
the only way, and it is deliberately hard to do by accident: it asks for the app
password and for you to type the instance's name. It removes everything —
applicants, scores, notes, votes, decisions — and cannot be undone. Export first.
