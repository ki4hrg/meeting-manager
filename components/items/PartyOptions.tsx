/** The options of a party select: people, then the context's groups. */
export function PartyOptions({
  people,
  groups,
}: {
  people: Array<{ id: string; name: string }>
  groups: Array<{ id: string; name: string }>
}) {
  return (
    <>
      <option value="">—</option>
      <optgroup label="People">
        {people.map((person) => (
          <option key={person.id} value={`person:${person.id}`}>
            {person.name}
          </option>
        ))}
      </optgroup>
      {groups.length > 0 ? (
        <optgroup label="Groups">
          {groups.map((group) => (
            <option key={group.id} value={`group:${group.id}`}>
              {group.name}
            </option>
          ))}
        </optgroup>
      ) : null}
    </>
  )
}
