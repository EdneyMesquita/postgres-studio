import { CircleCheckIcon, InfoIcon, Loader2Icon, OctagonXIcon, TriangleAlertIcon } from "lucide-react"
import { Toaster as Sonner, type ToasterProps } from "sonner"

import { useThemeStore } from "@/store/themeStore"

/** Confirmations bottom-right, above the status bar, in the app theme. */
const Toaster = ({ ...props }: ToasterProps) => {
  const theme = useThemeStore((s) => s.themeId)

  return (
    <Sonner
      theme={theme}
      position="bottom-right"
      offset={{ bottom: 36, right: 16 }}
      className="toaster group"
      icons={{
        success: <CircleCheckIcon className="size-4 text-ok" />,
        info: <InfoIcon className="size-4 text-accent-text" />,
        warning: <TriangleAlertIcon className="size-4 text-warn" />,
        error: <OctagonXIcon className="size-4 text-danger" />,
        loading: <Loader2Icon className="size-4 animate-spin" />,
      }}
      toastOptions={{
        classNames: {
          toast: "!gap-2.5 !rounded-lg !border-line !bg-popover !px-3.5 !py-2.5 !text-base !text-fg !shadow-overlay",
          description: "!text-xs !text-fg-2",
        },
      }}
      {...props}
    />
  )
}

export { Toaster }
