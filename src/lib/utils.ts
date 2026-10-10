import { clsx, type ClassValue } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";

// Teach tailwind-merge the project's extra font sizes (index.css @theme), or
// it reads `text-data` as a color and drops it next to `text-fg`.
const twMerge = extendTailwindMerge({
  extend: {
    theme: {
      text: ["2xs", "data"],
    },
  },
});

/** Joins class names, letting later Tailwind utilities override earlier ones. */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
