import { Component, type ErrorInfo, type ReactNode } from "react";
import { CircleAlert, FolderOpen, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { reportError } from "../../lib/log";
import { api } from "../../lib/tauri";

interface AppErrorBoundaryState {
  error: Error | null;
  /** Why the logs folder didn't open, if it didn't. */
  openError: string | null;
}

/**
 * Catches a render crash anywhere in the app, writes it to the log and
 * offers a way back, instead of leaving a blank window. The stores live
 * outside React, so "Try again" usually picks up where the user was.
 */
export class AppErrorBoundary extends Component<{ children: ReactNode }, AppErrorBoundaryState> {
  state: AppErrorBoundaryState = { error: null, openError: null };

  static getDerivedStateFromError(error: unknown): Partial<AppErrorBoundaryState> {
    return { error: error instanceof Error ? error : new Error(String(error)) };
  }

  componentDidCatch(error: unknown, info: ErrorInfo) {
    reportError("Render crash", error, info.componentStack ?? undefined);
  }

  private openLogs = () => {
    api.openLogDir().then(
      () => this.setState({ openError: null }),
      (e) => this.setState({ openError: String(e) }),
    );
  };

  render() {
    const { error, openError } = this.state;
    if (!error) return this.props.children;

    return (
      <div role="alert" className="grid h-screen place-items-center overflow-auto bg-editor px-6 py-10 text-fg">
        <div className="flex w-[min(560px,100%)] flex-col gap-3">
          <h1 className="m-0 flex items-center gap-2 text-lg font-semibold">
            <CircleAlert className="size-5 shrink-0 text-danger" aria-hidden />
            Something went wrong
          </h1>
          <p className="m-0 text-fg-2">
            Postgres Studio hit an error it couldn't recover from, and wrote it to the log. Try again,
            or reload the window if that doesn't help.
          </p>
          <pre className="m-0 max-h-48 overflow-auto rounded-md bg-danger/10 px-3 py-2 font-data break-words whitespace-pre-wrap text-danger select-text">
            {error.message || error.name}
          </pre>
          <div className="flex flex-wrap gap-2">
            <Button variant="primary" onClick={() => this.setState({ error: null, openError: null })}>
              <RotateCcw />
              Try again
            </Button>
            <Button onClick={() => window.location.reload()}>Reload window</Button>
            <Button variant="ghost" onClick={this.openLogs}>
              <FolderOpen />
              Open logs folder
            </Button>
          </div>
          {openError && <p className="m-0 text-sm text-danger">{openError}</p>}
        </div>
      </div>
    );
  }
}
