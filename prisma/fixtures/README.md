# CSV fixtures

## `s26-shape.csv`

**This file is entirely synthetic. It contains no real applicant data.**

Every name, email address, and essay response in it is invented. Emails use
`example.com`, the domain RFC 2606 reserves for documentation, so nothing here
can collide with a real USC address. Every response cell begins with the literal
word `SYNTHETIC` so a cell that leaks into a screenshot or a log is
self-identifying. This file is safe to commit, and `.gitignore` carries an
explicit `!prisma/fixtures/*.csv` exception so that the repo-wide `*.csv` ban in
PRD §8 does not swallow it.

### What it mirrors

The shape — not the content — of Spark SC's real S26 application export. It
follows the column vocabulary of `fixtures/sample-headers.csv`, which is the
real export's header row with zero data rows beneath it.

It exists so Phase 1 CSV parsing and field mapping can be built and tested
against realistic structure without real data ever entering the repo. The
hazards below are all deliberate: they are the things that actually break a
naive importer, reproduced on purpose so the parser has to handle them.

Shape: **29 columns, 28 data rows.** Line endings are CRLF and quoting follows
RFC 4180 throughout. Note that the file has more physical lines than records,
because two fields contain embedded newlines — a line-per-record reader will
mis-parse this file, which is one of the things it is here to catch.

Column order:

| Columns | Contents |
| --- | --- |
| 1–3 | `Email Address`, `First Name`, `Last Name` |
| 4–13 | ten one-hot ethnicity columns |
| 14 | `Specify your ethnicity, if not listed above:` (the write-in) |
| 15 | first-generation question |
| 16–18 | graduation date, major, pronouns |
| 19–23 | five response columns, each header a full essay prompt |
| 24–27 | four empty or near-empty columns |
| 28–29 | trailing form metadata (`Submit Date (UTC)`, `Network ID`) |

Columns 4–14 are the ethnicity **field group** described in PRD §5 and §10.7:
ten `OPTION` members plus one `FREE_TEXT` member. The write-in is a member for
display and reconciliation only, excluded from the checked predicate and from
the 1/n demographic counting.

### Ethnicity cell encoding

Each ethnicity cell holds either **that column's own header label, verbatim**,
or the empty string. Never `Y`/`N`, never `TRUE`/`FALSE`, never `1`/`0`. This
matches the real export, where the form writes the option's own text into the
cell when it is checked.

So a checked `East Asian` column contains the string `East Asian`; an unchecked
one contains nothing. "Checked" means non-empty, and an importer should verify
the value equals the header rather than assuming any non-empty value is a check.

### Header hazards

Each is present exactly once unless noted. Verify against the file:

- [ ] **One response header over 200 characters** — column 19, the "life
      journey" prompt, 261 characters. Anything that truncates or uses header
      text as a database identifier breaks here.
- [ ] **Two headers using curly quotes and curly apostrophes** — columns 20 and
      22. They contain U+2018/U+2019 curly apostrophes and U+201C/U+201D curly
      double quotes, plus em dashes. A mapper that hardcodes ASCII `'` or `"`
      will not match these.
- [ ] **One header containing an embedded newline** — column 21, quoted per RFC
      4180. The header row therefore spans two physical lines. Splitting the
      file on `\n` to find the header will produce a broken column list.
- [ ] **One header with a trailing space** — column 23, ends `contribute? `.
      Header lookups that do not trim will miss this column; lookups that *do*
      trim must not then collide with anything else.
- [ ] **Two ethnicity headers where one is a strict prefix of the other** —
      `Black` (column 5) and `Black or African American` (column 6). Any
      matching built on `startsWith`, `includes`, or a loose `LIKE` will map
      one to the other. Only exact comparison works. The file exercises all
      three cases, and these lists are exhaustive: `Black` without the longer
      column (Rowan Fixture, Fen Dummy, Zeph Placeholder), `Black or African
      American` without `Black` (Avery Sampleton, Gale Synthetic), and both at
      once (Harper Lorem).

Column 14's header also contains a comma and is quoted — worth confirming your
parser handles, though it is ordinary RFC 4180 rather than a hazard.

### Row hazards

Each is present exactly once. Rows are identified by name, since embedded
newlines make physical line numbers unreliable:

- [ ] **Two rows sharing an email exactly** — Avery Sampleton and Avery
      Duplicate, both `avery.fixture@example.com`. Different last names, so
      this is not a pure duplicate row. Import must not silently collapse them,
      and must not key anything on the address.
- [ ] **Two rows sharing an email only after normalizing** — Bex Placeholder,
      `bex.placeholder@example.com`, and Bex Casedupe,
      `Bex.Placeholder@Example.com`. Byte-different, so a verbatim comparison
      sees two distinct addresses; identical once trimmed and lowercased.
      Duplicate detection that runs on the raw value passes this pair at
      preview and then fails `UNIQUE (instanceId, email)` at commit, after the
      admin has already approved the import. Deliberately placed far from its
      partner — adjacent duplicates are the easy case.
- [ ] **One row with a blank email** — Emory Noemail. No address at all.
- [ ] **One row with a blank last name** — Indigo,
      `indigo.nolastname@example.com`. First name only.
- [ ] **One row whose email has leading and trailing whitespace** —
      Quinn Spacey, `␣␣quinn.sample@example.com␣␣`. The spaces are unquoted and
      are part of the field per RFC 4180 §2.4. Untrimmed, this will not match
      the same address written normally.
- [ ] **One row checking no ethnicity box but filling the write-in** — Pax
      Writein, write-in `Afro-Caribbean (synthetic write-in)`. Zero checked
      options with free text present. Per §10.7 the write-in does not count
      toward demographics, so this applicant contributes no ethnicity counts
      while still having a non-empty answer to display.
- [ ] **One row checking three ethnicity boxes** — Rowan Fixture: `Black`,
      `Hispanic/LatinX`, `White`, plus a write-in. Exercises 1/n counting with
      n = 3.
- [ ] **One row checking none, with an empty write-in** — Tobin Blankethnicity.
      The entire field group is empty. Distinct from Pax Writein above, and both
      must be distinguishable from a parse failure.

### Additional properties

Not requested, but present because the file exists to exercise a parser, and
noted here so the checklists above stay exact:

- One **data** cell contains an embedded newline (Gale Synthetic, column 21).
- One **data** cell contains double quotes, escaped as `""` (Devi Stubbs,
  column 20).
- Columns 24 (`Other Major:`) and 27 (`Tags`) are entirely empty across all 28
  rows. Columns 25 (`Minor:`) and 26 (`Anything else…`) hold two and one
  non-empty values respectively — near-empty, so a column that looks droppable
  in the first twenty rows is not actually droppable.
- A column that is entirely empty has **no** value signature, and group
  detection must not treat "every non-empty value is the same literal" as
  satisfied over zero values. Columns 24 and 27 are the trap.

### Regenerating

The file is committed and hand-maintainable. If you edit it, re-verify that
every box above still holds — several hazards are easy to destroy accidentally,
particularly the trailing space in the column 23 header and the leading spaces
on Quinn Spacey's email, both of which editors strip on save.
