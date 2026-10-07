/* What the seeded world holds, by name, for the tests to find. */

export const E2E_PORT = 3100

export const ACCOUNT = {
  email: 'john@example.test',
  password: 'correct horse battery staple',
  name: 'John',
}

export const WORLD = {
  contexts: { conference: 'Conference', church: 'Church' },
  people: { adlene: 'Adlene Kufarimai', sarah: 'Sarah Jones' },
  projects: { standing: 'Annual Conference', year: '2027 Annual Conference', worship: 'AC2027 Worship' },
  items: {
    overdue: 'Send chairs the form for agency meeting dates',
    lunch: 'Arrange the staff Christmas lunch',
    bulletin: 'Draft the bulletin insert',
    accountability: 'Accountability process for team-to-team collaborations',
    delegateCost: 'Estimated per-delegate cost for General Conference',
  },
  meetings: { checkIn: 'Adlene/John Check-In', finance: 'Finance committee' },
  proposal: 'Get three quotes for the boiler',
}
