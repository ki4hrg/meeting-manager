/* What the seeded world holds, by name, for the tests to find. */

export const E2E_PORT = 3100

export const ACCOUNT = {
  email: 'john@example.test',
  password: 'correct horse battery staple',
  name: 'John',
}

export const WORLD = {
  contexts: { conference: 'Conference', church: 'Church' },
  people: { adlene: 'Adlene Kufarimai', sarah: 'Sarah Jones', bishop: 'Bishop Wright' },
  projects: { standing: 'Annual Conference', year: '2027 Annual Conference', worship: 'AC2027 Worship' },
  items: {
    overdue: 'Send chairs the form for agency meeting dates',
    lunch: 'Arrange the staff Christmas lunch',
    bulletin: 'Draft the bulletin insert',
    accountability: 'Accountability process for team-to-team collaborations',
    delegateCost: 'Estimated per-delegate cost for General Conference',
    scripture: 'What is the scripture for closing worship?',
    longForm: 'Does the bishop want the long form of the liturgy?',
    loose: 'Ideas for the youth retreat',
    venue: 'Confirm the venue contract',
    policy: 'Vulnerable adults policy update',
  },
  meetings: {
    checkIn: 'Adlene/John Check-In',
    finance: 'Finance committee',
    planning: 'Worship planning',
    bishop: 'With the bishop',
    /* A long title, as calendar titles are: it widens every picker it is in. */
    venue: 'Hilton Garden Inn/Homewood Suites Site Visit and Contract Review',
    camps: 'Camps review',
    /* Two recordings filed on it by time. */
    siteVisit: 'Site visit',
    /* And a debrief begun just after it. */
    walkThrough: 'Hall walk-through',
    debrief: 'Walk-through debrief',
  },
  notes: {
    tour: 'The tour',
    oneToOne: 'Sarah and John',
  },
  proposal: 'Get three quotes for the boiler',
  /* Raised at a meeting as a topic, and more than one: accepted as a project. */
  projectProposal: 'Rewrite the camp policy',
}
