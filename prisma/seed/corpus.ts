// Synthetic text pools. Everything here is invented. Real applicant data never
// enters this repo — see PRD section 8 and CLAUDE.md rule 3.

export const FIRST_NAMES = [
  "Amara", "Priya", "Diego", "Mei", "Jonah", "Leila", "Tomás", "Anaya", "Ravi", "Sofia",
  "Kenji", "Fatima", "Ellis", "Nadia", "Marcus", "Yuki", "Ibrahim", "Camila", "Theo", "Zara",
  "Hana", "Andre", "Ines", "Malik", "Rosa", "Kwame", "Lucia", "Arjun", "Noor", "Felix",
  "Simone", "Dev", "Talia", "Omar", "Bianca", "Sung", "Adaeze", "Mateo", "Freya", "Rohan",
  "Imani", "Lars", "Chiara", "Nikhil", "Elena", "Kofi", "Sana", "Julian", "Mira", "Emeka",
  "Wren", "Sebastián", "Aiko", "Darius", "Paloma", "Idris", "Thea", "Rafael", "Xiuying", "Noa",
];

export const LAST_NAMES = [
  "Okafor", "Nakamura", "Alvarez", "Chen", "Bergström", "Haddad", "Rivera", "Sharma", "Osei", "Moreau",
  "Tanaka", "Rahman", "Whitfield", "Petrova", "Delgado", "Kim", "Adeyemi", "Rossi", "Lindqvist", "Farouk",
  "Vasquez", "Mwangi", "Park", "Novak", "Castellanos", "Iqbal", "Silva", "Boateng", "Marchetti", "Nguyen",
  "Fitzgerald", "Ansari", "Duarte", "Ekwueme", "Lindgren", "Contreras", "Yamada", "Bouchard", "Sandoval", "Kaur",
  "Blackwood", "Amadi", "Ferreira", "Hoffmann", "Zhao", "Okonjo", "Reyes", "Lindstrom", "Bhatt", "Cortez",
  "Abiodun", "Fontaine", "Villanueva", "Sørensen", "Ishikawa", "Mbeki", "Larsen", "Quintero", "Nasser", "Wu",
];

export const MAJORS = [
  "Business Administration",
  "Computer Science",
  "Computer Science and Business Administration",
  "Economics",
  "Communication",
  "Industrial and Systems Engineering",
  "Mechanical Engineering",
  "Biomedical Engineering",
  "Psychology",
  "Political Science",
  "Cinematic Arts, Film and Television Production",
  "Public Policy",
  "Data Science",
  "Neuroscience",
  "Accounting",
  "International Relations",
  "Design",
  "Environmental Studies",
  "Other",
];

export const MINORS = [
  "Entrepreneurship",
  "Applied Analytics",
  "Cinematic Arts",
  "Consumer Behavior",
  "Web Technologies and Applications",
  "Public Health",
  "Music Industry",
  "Marketing",
  "Human Security and Geospatial Intelligence",
  "Product Design",
  "Themed Entertainment",
  "Communication Design",
];

/// Written into "Other Major:" / "Other Second Major:" only when the paired
/// dropdown says "Other" — which is why those columns are ~90% empty in the real
/// export, and must be here too.
export const WRITE_IN_MAJORS = [
  "Cognitive Science",
  "Astronautical Engineering",
  "Health and Human Sciences",
  "Iovine and Young Academy",
  "Global Studies",
  "Narrative Studies",
  "Quantitative Biology",
];

export const GRADUATION_DATES = [
  "May 2027",
  "May 2028",
  "May 2029",
  "December 2027",
  "December 2028",
  "May 2030",
];

export const HEARD_ABOUT = [
  "Involvement Fair",
  "A friend in Spark SC",
  "Instagram",
  "Class announcement",
  "LinkedIn",
  "Someone on my floor",
  "Spark SC event last semester",
  "Marshall newsletter",
  "Word of mouth",
];

export const PRONOUNS = [
  "she/her",
  "he/him",
  "they/them",
  "she/they",
  "he/they",
  "Prefer not to say",
];

export const TAGS = ["referral", "late-submission", "reopened", "duplicate-check", "follow-up"];

export const SELF_DESCRIBED_ETHNICITIES = [
  "Punjabi",
  "Taiwanese",
  "Afro-Latina",
  "Persian",
  "Vietnamese and White",
  "Igbo",
  "Filipino",
  "Armenian",
  "Mexican-American",
  "Han Chinese",
  "Ethiopian",
  "Salvadoran",
];

/// Weighted so the multi-select case is common enough to test against. Weights
/// are invented and are not a claim about any real applicant pool.
export const ETHNICITY_WEIGHTS: readonly (readonly [string, number])[] = [
  ["American Indian/Alaskan Native/First Nations", 1],
  ["Black", 8],
  ["Central Asian", 2],
  ["Hispanic/LatinX", 16],
  ["East Asian", 24],
  ["Middle Eastern/North African", 5],
  ["Native Hawaiian/Pacific Islander", 1],
  ["South Asian", 14],
  ["Southeast Asian", 9],
  ["White", 26],
];

/// The "Ending" column: the same templated string on every row. A column with
/// zero variance across 150 rows is the clearest possible signal of junk, and the
/// import UI should make excluding it a single obvious click.
export const ENDING_TEMPLATE =
  "Thanks for applying to Spark SC! We review every application carefully and will " +
  "be in touch by email with next steps. If you have questions in the meantime, " +
  "reach out to our recruitment team. Fight on!";

interface EssayPool {
  openers: readonly string[];
  middles: readonly string[];
  closers: readonly string[];
}

export const ESSAY_POOLS = {
  essayJourney: {
    openers: [
      "I grew up translating paperwork for my parents, which taught me early that being useful and being fluent are the same skill.",
      "Before USC I spent two years working weekends at my family's restaurant, and I did not think of that as experience until recently.",
      "I moved three times before high school, so I got good at reading a room quickly and bad at assuming anything would stay put.",
      "For most of high school I was the kid who joined everything and finished nothing, which is a harder habit to break than it sounds.",
    ],
    middles: [
      "College was the first place where nobody already had a category for me, and that turned out to be freeing rather than lonely.",
      "The biggest shift has been learning to ask for help before I have exhausted every other option, which used to feel like losing.",
      "I stopped optimizing for looking competent and started optimizing for learning fast, and the difference showed up within a semester.",
      "I found a group of people who take their work seriously without taking themselves seriously, and I started doing the same.",
      "What changed is not my ambition but my patience with the parts of a project that are slow and unglamorous.",
    ],
    closers: [
      "I am not the same person who wrote my college essays, and I am glad about that.",
      "That shift is most of what I would bring to a team like this one.",
      "I still have the restlessness, but it points somewhere now.",
    ],
  },
  essayExperience: {
    openers: [
      "I was cut from a startup accelerator in the first round of interviews and spent a week convinced the feedback was wrong.",
      "The first product I built got eleven users, nine of whom I was related to.",
      "A professor told me my analysis was confident and unsupported, and she was right on both counts.",
      "I ran an event that forty people RSVPed to and six attended.",
    ],
    middles: [
      "What actually stung was that the feedback was specific, which meant I could not dismiss it as a matter of taste.",
      "I went back through what I had assumed and found that I had never once asked a potential user a question I did not already know the answer to.",
      "It took me longer than it should have to separate the disappointment from the information inside it.",
      "I rebuilt the whole thing around the one piece of feedback I had been most defensive about.",
    ],
    closers: [
      "Now I go looking for the version of the feedback I would least like to hear, because that is usually the useful one.",
      "I treat early rejection as cheap information rather than a verdict, which has made me much faster.",
      "That experience is why I no longer wait until something is polished to show it to someone.",
    ],
  },
  essayCared: {
    openers: [
      "I built a free tool that helps transfer students figure out which of their credits actually count.",
      "I started a tutoring program at my old high school and ran it for two years.",
      "I spent a summer digitizing my grandmother's recipes into something my whole extended family could actually use.",
      "I organized a repair cafe on campus after watching three roommates throw out working electronics.",
    ],
    middles: [
      "The first step was talking to eleven people who had the problem, before I wrote a single line of anything.",
      "I mapped the process by hand on paper first, which caught two dead ends that would have cost me weeks.",
      "I recruited two friends by giving them ownership of a piece rather than tasks, and they are still involved.",
      "I set a hard deadline of four weeks for something usable, and shipped something embarrassing on time instead of something good late.",
      "I tracked one number weekly and killed the features that did not move it.",
    ],
    closers: [
      "It is still running, which I care about more than whether it is impressive.",
      "The thing I am proudest of is that it outlasted my involvement.",
      "It taught me that the constraint is almost never the idea.",
    ],
  },
  essayProblem: {
    openers: [
      "Club recruitment at USC is opaque: applicants cannot tell what any organization actually wants until after they are rejected.",
      "Study spaces on campus are either empty or impossible to find, and there is no way to know which before walking there.",
      "Transfer students lose an average of a semester to credit confusion nobody at the university seems to own.",
      "Student organizations rebuild the same operational infrastructure every year because nothing is handed down.",
    ],
    middles: [
      "The first small experiment would be a one-week manual version: a spreadsheet and a form, no code at all.",
      "I would start by asking twenty students to describe the problem in their own words before proposing anything.",
      "I would test whether people would use it at all by faking the backend and doing the work by hand for ten users.",
      "I would run it for a single dorm first, because a solution that does not work for one floor will not work for a campus.",
    ],
    closers: [
      "If nobody uses the manual version, the automated version was never the answer.",
      "The point of the experiment is to be wrong cheaply rather than right slowly.",
      "I would rather learn it does not matter in a week than in a semester.",
    ],
  },
  essayMission: {
    openers: [
      "Spark SC treats entrepreneurship as something you practice rather than something you credential, which is why I want in.",
      "What draws me is that Spark SC builds things for the campus rather than pitching things at it.",
      "I have been to a lot of entrepreneurship events that were mostly networking, and Spark SC is visibly not that.",
    ],
    middles: [
      "I would bring operational follow-through, which is the least glamorous and most missing skill in student organizations.",
      "I can do the unglamorous half: scheduling, logistics, the second and third follow-up email.",
      "I have run events end to end and I know how much of the work happens after the excitement wears off.",
      "I would push for measuring whether our programming actually helps anyone, rather than counting attendance.",
    ],
    closers: [
      "I am less interested in being in the room than in making the room work.",
      "I would rather own one thing completely than be adjacent to five.",
      "I want to be somewhere that expects me to ship.",
    ],
  },
  essayChangedMind: {
    openers: [
      "I used to believe that the best idea wins, and that execution was a detail people used as an excuse.",
      "I was certain that working alone was faster, and I had a lot of evidence for it.",
      "I believed that if something was genuinely useful, it would spread on its own.",
    ],
    middles: [
      "What changed my mind was watching a worse idea, executed relentlessly, beat mine over a single semester.",
      "The evidence was boring and undeniable: every project I did alone stalled at exactly the point where it needed someone else to care.",
      "A friend showed me their retention data, and it turned out that useful and used are unrelated properties.",
    ],
    closers: [
      "Now I assume my first read on a situation is incomplete and go looking for who would disagree.",
      "I hold opinions more loosely and test them earlier, which is less satisfying and much more effective.",
      "I try to write down what would change my mind before I get attached to being right.",
    ],
  },
  anythingElse: {
    openers: [
      "I am also on the club climbing team, which is where most of my best ideas happen.",
      "I speak three languages badly and one well, and I am working on that ratio.",
      "I run a small newsletter about campus food, which has more subscribers than anything else I have made.",
      "I am a transfer student, so I have seen how two very different institutions handle the same problems.",
    ],
    middles: [
      "Happy to talk about any of this if it is useful.",
      "I mention it only because it is where I have learned the most about working with people.",
    ],
    closers: ["Thanks for reading all of this.", "Either way, thank you for the time."],
  },
} as const satisfies Record<string, EssayPool>;

export type EssayKey = keyof typeof ESSAY_POOLS;
