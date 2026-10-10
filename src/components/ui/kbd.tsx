import * as React from "react"
import { cn } from "@/lib/utils"

/** A keycap for shortcut hints: <Kbd>Ctrl</Kbd><Kbd>K</Kbd>. */
function Kbd({ className, ...props }: React.ComponentProps<"kbd">) {
  return (
    <kbd
      data-slot="kbd"
      className={cn(
        "inline-flex h-[18px] items-center rounded-sm border border-b-2 border-line bg-editor px-1.5 font-sans text-2xs font-medium text-fg-2",
        "[[data-slot=button][data-variant=primary]_&]:border-white/35 [[data-slot=button][data-variant=primary]_&]:bg-transparent [[data-slot=button][data-variant=primary]_&]:text-white/85",
        className
      )}
      {...props}
    />
  )
}

export { Kbd }
