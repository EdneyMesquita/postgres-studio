interface HighlightedProps {
  name: string;
  /** The search, lowercased; empty highlights nothing. */
  query: string;
}

/** The name with the part matching the search picked out. */
export function Highlighted({ name, query }: HighlightedProps) {
  const at = query ? name.toLowerCase().indexOf(query) : -1;
  if (at < 0) return <>{name}</>;
  return (
    <>
      {name.slice(0, at)}
      <mark className="bg-transparent font-semibold text-accent-text">
        {name.slice(at, at + query.length)}
      </mark>
      {name.slice(at + query.length)}
    </>
  );
}
