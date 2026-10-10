import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { cn } from "@/lib/utils"
import { Slot } from "radix-ui"

/*
 * DESIGN.md buttons: 28px, 6px radius, 16px icons; one primary per bar.
 * primary (blue fill), secondary (hairline stroke), ghost (no stroke,
 * secondary text), destructive, link. Icon sizes are square.
 */
const buttonVariants = cva(
  "inline-flex shrink-0 items-center justify-center gap-1.5 rounded-md text-base whitespace-nowrap outline-none transition-colors duration-100 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring disabled:pointer-events-none disabled:opacity-45 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        primary: "bg-primary font-medium text-primary-foreground hover:bg-accent-hover",
        secondary: "border border-field-line text-fg hover:bg-hover",
        ghost: "text-fg-2 hover:bg-hover hover:text-fg aria-expanded:bg-hover aria-expanded:text-fg aria-pressed:bg-hover aria-pressed:text-fg",
        destructive: "bg-destructive font-medium text-white hover:bg-destructive/90",
        link: "h-auto px-0 text-accent-text underline-offset-4 hover:underline",
      },
      size: {
        default: "h-7 px-2.5",
        sm: "h-6 gap-1 px-2 text-sm [&_svg:not([class*='size-'])]:size-3.5",
        icon: "size-7",
        "icon-sm": "size-6 [&_svg:not([class*='size-'])]:size-3.5",
        "icon-xs": "size-5 rounded-sm [&_svg:not([class*='size-'])]:size-3",
      },
    },
    defaultVariants: {
      variant: "secondary",
      size: "default",
    },
  }
)

function Button({
  className,
  variant = "secondary",
  size = "default",
  asChild = false,
  ...props
}: React.ComponentProps<"button"> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean
  }) {
  const Comp = asChild ? Slot.Root : "button"

  return (
    <Comp
      data-slot="button"
      data-variant={variant}
      data-size={size}
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  )
}

export { Button, buttonVariants }
