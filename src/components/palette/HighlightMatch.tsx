interface HighlightMatchProps {
  text: string;
  /** What was typed; its first occurrence in `text` is marked. */
  query: string;
}

/** Text with the typed part in link blue, as in the quick-open palette. */
export function HighlightMatch({ text, query }: HighlightMatchProps) {
  const q = query.trim().toLowerCase();
  const at = q ? text.toLowerCase().indexOf(q) : -1;
  if (at < 0) return <>{text}</>;
  return (
    <>
      {text.slice(0, at)}
      <mark className="bg-transparent font-semibold text-accent-text">
        {text.slice(at, at + q.length)}
      </mark>
      {text.slice(at + q.length)}
    </>
  );
}
