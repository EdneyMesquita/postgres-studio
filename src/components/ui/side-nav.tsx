import { useRef, type KeyboardEvent, type ReactNode } from "react"
import { cn } from "@/lib/utils"

export interface SideNavSection<T extends string> {
  id: T
  label: string
  icon: ReactNode
  /** Faint trailing text, e.g. "On" / "Off". */
  state?: string
}

interface SideNavProps<T extends string> {
  sections: SideNavSection<T>[]
  value: T
  onChange: (section: T) => void
  "aria-label": string
  /** id prefix tying each tab to the panel `${idPrefix}-panel`. */
  idPrefix: string
  /** Above the tabs, e.g. a search field. */
  header?: ReactNode
  /** Under the tabs when there are none, e.g. "No setting matches". */
  empty?: ReactNode
}

/**
 * A dialog's left column: one vertical tab per section, arrow keys moving
 * between them (the connection dialog, Settings, import / export).
 */
export function SideNav<T extends string>({ sections, value, onChange, idPrefix, header, empty, ...aria }: SideNavProps<T>) {
  const refs = useRef<(HTMLButtonElement | null)[]>([])

  function onKeyDown(e: KeyboardEvent, index: number) {
    const next =
      e.key === "ArrowDown" ? index + 1
      : e.key === "ArrowUp" ? index - 1
      : e.key === "Home" ? 0
      : e.key === "End" ? sections.length - 1
      : null
    if (next === null) return
    e.preventDefault()
    const wrapped = (next + sections.length) % sections.length
    onChange(sections[wrapped].id)
    refs.current[wrapped]?.focus()
  }

  return (
    <nav className="flex min-h-0 flex-col gap-0.5 overflow-y-auto border-r border-line bg-panel px-2 py-2.5">
      {header}
      <div role="tablist" aria-orientation="vertical" aria-label={aria["aria-label"]} className="flex flex-col gap-0.5">
        {sections.map((section, i) => {
          const selected = section.id === value
          return (
            <button
              key={section.id}
              ref={(el) => {
                refs.current[i] = el
              }}
              type="button"
              role="tab"
              id={`${idPrefix}-tab-${section.id}`}
              aria-selected={selected}
              aria-controls={`${idPrefix}-panel`}
              tabIndex={selected ? 0 : -1}
              onClick={() => onChange(section.id)}
              onKeyDown={(e) => onKeyDown(e, i)}
              className={cn(
                "flex h-8 items-center gap-2.5 rounded-md px-2.5 text-left text-base text-fg-2 outline-none transition-colors duration-100 hover:bg-hover hover:text-fg focus-visible:outline-2 focus-visible:outline-ring [&_svg]:size-3.5 [&_svg]:shrink-0",
                selected && "bg-sel text-fg hover:bg-sel",
              )}
            >
              {section.icon}
              {section.label}
              {section.state && <span className="ml-auto truncate pl-2 text-xs text-fg-3">{section.state}</span>}
            </button>
          )
        })}
      </div>
      {sections.length === 0 && empty}
    </nav>
  )
}
