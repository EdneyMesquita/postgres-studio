import type { ReactNode } from "react"
import { cn } from "@/lib/utils"

export interface SegmentOption<T extends string> {
  value: T
  label: ReactNode
  icon?: ReactNode
  /** Accessible name when the segment shows only an icon. */
  title?: string
}

interface SegmentedControlProps<T extends string> {
  value: T
  onChange: (value: T) => void
  options: SegmentOption<T>[]
  "aria-label": string
  /** Icon-only segments, tighter padding. */
  iconOnly?: boolean
  className?: string
}

/**
 * A few mutually exclusive views or modes in a tinted track; the chosen one
 * lifts (DESIGN.md: segmented control).
 */
export function SegmentedControl<T extends string>({
  value,
  onChange,
  options,
  iconOnly = false,
  className,
  ...aria
}: SegmentedControlProps<T>) {
  return (
    <div
      role="group"
      aria-label={aria["aria-label"]}
      className={cn("inline-flex shrink-0 gap-0.5 rounded-md bg-fg/6 p-0.5", className)}
    >
      {options.map((option) => {
        const pressed = option.value === value
        return (
          <button
            key={option.value}
            type="button"
            aria-pressed={pressed}
            title={option.title}
            aria-label={iconOnly ? option.title : undefined}
            onClick={() => onChange(option.value)}
            className={cn(
              "inline-flex h-6 items-center gap-1.5 rounded-sm whitespace-nowrap text-fg-2 outline-none transition-colors duration-100 hover:text-fg focus-visible:outline-2 focus-visible:outline-ring [&_svg]:size-3.5 [&_svg]:shrink-0",
              iconOnly ? "px-1.5" : "px-2.5",
              pressed && "bg-editor text-fg shadow-[var(--t-segment-lift),0_0_0_1px_var(--color-line)]"
            )}
          >
            {option.icon}
            {!iconOnly && option.label}
          </button>
        )
      })}
    </div>
  )
}
