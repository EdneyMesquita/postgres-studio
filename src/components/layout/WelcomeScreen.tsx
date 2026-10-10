import { FileCode, Loader2, Lock, Network, Plus, Search, SquareTerminal, Upload } from "lucide-react";
import { ConnectionChip } from "@/components/ui/ConnectionChip";
import { Kbd } from "@/components/ui/kbd";
import { version } from "../../../package.json";
import { connectionColor } from "../../lib/connectionColor";
import { useConnectionsStore } from "../../store/connectionsStore";
import { useUiStore } from "../../store/uiStore";
import { AppLogo } from "./AppLogo";
import { WelcomeAction } from "./WelcomeAction";

/** Nothing connected and nothing open: how to start, and every saved server. */
export function WelcomeScreen() {
  const profiles = useConnectionsStore((s) => s.profiles);
  const profilesLoaded = useConnectionsStore((s) => s.profilesLoaded);
  const connecting = useConnectionsStore((s) => s.connecting);
  const connectErrors = useConnectionsStore((s) => s.connectErrors);
  const setConnectionDialog = useUiStore((s) => s.setConnectionDialog);
  const setSidePanel = useUiStore((s) => s.setSidePanel);
  const setPaletteOpen = useUiStore((s) => s.setPaletteOpen);
  const setImportExportOpen = useUiStore((s) => s.setImportExportOpen);

  async function connect(id: string) {
    await useConnectionsStore.getState().connect(id);
    // Its databases are in the Explorer, so show it.
    if (useConnectionsStore.getState().sessions[id]) setSidePanel("explorer");
  }

  return (
    <div className="grid flex-1 place-items-center overflow-auto px-6 py-10">
      <div className="grid w-[min(760px,100%)] grid-cols-2 gap-12 max-[960px]:grid-cols-1 max-[960px]:gap-7">
        <h1 className="col-span-full m-0 flex items-center gap-3.5 text-xl font-semibold tracking-[-0.01em]">
          <AppLogo className="size-10" />
          <span>
            Postgres Studio
            <small className="mt-0.5 block text-base font-normal tracking-normal text-fg-2">
              Version {version} · everything stays on this machine
            </small>
          </span>
        </h1>

        <section>
          <h2 className="mb-2 text-sm font-semibold text-fg-2">Start</h2>
          <div className="flex flex-col">
            <WelcomeAction
              icon={<Plus />}
              trailing={<Kbd>Ctrl N</Kbd>}
              onClick={() => setConnectionDialog({ mode: "new" })}
            >
              New connection
            </WelcomeAction>
            <WelcomeAction icon={<Upload />} onClick={() => setImportExportOpen(true)}>
              Import connections (pgAdmin servers.json)…
            </WelcomeAction>
            <WelcomeAction icon={<FileCode />} onClick={() => setSidePanel("scripts")}>
              Open a saved script…
            </WelcomeAction>
            <WelcomeAction
              icon={<Search />}
              trailing={<Kbd>Ctrl K</Kbd>}
              onClick={() => setPaletteOpen(true)}
            >
              Search everything
            </WelcomeAction>
          </div>
        </section>

        <section>
          <h2 className="mb-2 text-sm font-semibold text-fg-2">Connect</h2>
          <div className="flex flex-col">
            {profilesLoaded && profiles.length === 0 && (
              <p className="py-2 text-sm text-fg-3">
                No saved connections yet. Add one, or import them from another tool.
              </p>
            )}
            {profiles.map((p) => (
              <WelcomeAction
                key={p.id}
                icon={<ConnectionChip name={p.name} color={connectionColor(p.id, p.color)} />}
                disabled={!!connecting[p.id]}
                onClick={() => connect(p.id)}
                trailing={
                  connecting[p.id] ? (
                    <Loader2 className="size-3.5 animate-spin text-fg-3" />
                  ) : connectErrors[p.id] ? (
                    <span className="truncate text-xs text-danger" title={connectErrors[p.id]}>
                      {connectErrors[p.id]}
                    </span>
                  ) : (
                    <span className="truncate font-data text-fg-3">{p.summary}</span>
                  )
                }
              >
                {p.name}
              </WelcomeAction>
            ))}
          </div>
        </section>

        <div className="col-span-full grid grid-cols-[repeat(3,auto)] justify-between gap-x-4.5 gap-y-3 border-t border-line-soft pt-4 text-sm text-fg-2 max-[960px]:grid-cols-1 [&_svg]:size-3 [&>span]:inline-flex [&>span]:items-center [&>span]:gap-1.5">
          <span>
            <Lock />
            Passwords live in the system keychain
          </span>
          <span>
            <Network />
            Connect to several servers at once
          </span>
          <span>
            <SquareTerminal />
            SQL console with transactions and EXPLAIN
          </span>
        </div>
      </div>
    </div>
  );
}
