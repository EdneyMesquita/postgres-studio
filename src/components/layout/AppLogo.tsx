import { useId } from "react";
import { cn } from "@/lib/utils";

interface AppLogoProps {
  className?: string;
}

/**
 * The app icon (src-tauri/icons/icon-source.svg), inline so it scales
 * crisply at any size. Gradient ids are per instance: two logos on screen
 * (toolbar and welcome) mustn't share them.
 */
export function AppLogo({ className }: AppLogoProps) {
  // useId's punctuation doesn't survive url(#...) everywhere
  const id = `logo${useId().replace(/[^\w-]/g, "")}`;
  const bg = `${id}-bg`;
  const body = `${id}-body`;
  const card = `${id}-card`;
  return (
    <svg viewBox="0 0 1024 1024" aria-hidden className={cn("shrink-0", className)}>
      <defs>
        <linearGradient id={bg} x1="0" y1="0" x2="1024" y2="1024" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#232838" />
          <stop offset="1" stopColor="#0b0d12" />
        </linearGradient>
        <linearGradient id={body} x1="512" y1="262" x2="512" y2="762" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#6E9BFF" />
          <stop offset="1" stopColor="#2A5DC9" />
        </linearGradient>
        <clipPath id={card}>
          <rect x="212" y="262" width="600" height="500" rx="76" />
        </clipPath>
      </defs>
      <rect width="1024" height="1024" rx="200" fill={`url(#${bg})`} />
      <g clipPath={`url(#${card})`}>
        <rect x="212" y="262" width="600" height="500" fill={`url(#${body})`} />
        <rect x="212" y="262" width="600" height="150" fill="#B7CDFF" />
        <path
          d="M 212 412 H 812 M 212 528 H 812 M 212 644 H 812 M 418 412 V 762"
          stroke="#163A88"
          strokeWidth="20"
          opacity=".55"
        />
      </g>
      <circle cx="314" cy="337" r="34" fill="#163A88" opacity=".8" />
      <rect x="386" y="320" width="330" height="34" rx="17" fill="#163A88" opacity=".45" />
    </svg>
  );
}
