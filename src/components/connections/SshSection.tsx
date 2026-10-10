import { Lock } from "lucide-react";
import { Input } from "@/components/ui/input";
import { useConnectionsStore } from "@/store/connectionsStore";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  emptySshTunnelOptions,
  type SshAuthMethod,
  type SshTunnelOptions,
} from "@/types/connection";
import { DATA_FIELD, KEEP_SAVED, type ConnectionSectionProps } from "./connectionFormTypes";
import { Field } from "./Field";
import { FieldRow } from "./FieldRow";
import { FilePicker } from "./FilePicker";
import { SwitchField } from "./SwitchField";


export function SshSection({ input, update, editing }: ConnectionSectionProps) {
  // Shown greyed out while off; turning it off drops the settings.
  const ssh = input.sshTunnel ?? emptySshTunnelOptions();
  const off = !ssh.enabled;
  const keychain = useConnectionsStore((s) => s.secretBackend?.backend !== "encrypted_file");
  const secretsHelp = (
    <>
      <Lock />
      {keychain ? "Passphrases go to the system keychain." : "Passphrases are saved encrypted."}
    </>
  );
  const set = (patch: Partial<SshTunnelOptions>) => update("sshTunnel", { ...ssh, ...patch });

  return (
    <>
      <SwitchField
        label="Connect through an SSH tunnel"
        description="For servers only reachable from a bastion host."
        checked={ssh.enabled}
        onCheckedChange={(on) =>
          update("sshTunnel", on ? { ...ssh, enabled: true } : null)
        }
      />
      <FieldRow>
        <Field label="SSH host" htmlFor="ssh-host">
          <Input
            id="ssh-host"
            className={DATA_FIELD}
            spellCheck={false}
            value={ssh.host}
            onChange={(e) => set({ host: e.target.value })}
            placeholder="bastion.example.com"
            disabled={off}
          />
        </Field>
        <Field label="Port" htmlFor="ssh-port">
          <Input
            id="ssh-port"
            className={DATA_FIELD}
            type="number"
            value={ssh.port}
            onChange={(e) => set({ port: Number(e.target.value) })}
            disabled={off}
          />
        </Field>
      </FieldRow>
      <FieldRow>
        <Field label="Username" htmlFor="ssh-user">
          <Input
            id="ssh-user"
            autoComplete="off"
            value={ssh.username}
            onChange={(e) => set({ username: e.target.value })}
            disabled={off}
          />
        </Field>
        <Field label="Authenticate with" htmlFor="ssh-auth">
          <Select
            value={ssh.authMethod}
            onValueChange={(authMethod) => set({ authMethod: authMethod as SshAuthMethod })}
            disabled={off}
          >
            <SelectTrigger id="ssh-auth" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="password">Password</SelectItem>
              <SelectItem value="private_key">Private key</SelectItem>
              <SelectItem value="agent">SSH agent (not yet supported)</SelectItem>
            </SelectContent>
          </Select>
        </Field>
      </FieldRow>
      {ssh.authMethod === "password" && (
        <Field
          label="SSH password"
          htmlFor="ssh-password"
          help={
            <>
              <Lock />
              {keychain
                ? "Saved in the system keychain, never in the connection file"
                : "Saved encrypted, never in the connection file"}
            </>
          }
        >
          <Input
            id="ssh-password"
            type="password"
            autoComplete="new-password"
            value={input.sshPassword ?? ""}
            onChange={(e) => update("sshPassword", e.target.value || null)}
            placeholder={editing?.sshTunnel ? KEEP_SAVED : undefined}
            disabled={off}
          />
        </Field>
      )}
      {ssh.authMethod === "private_key" && (
        <>
          <Field label="Private key" htmlFor="ssh-key" help={secretsHelp}>
            <FilePicker
              id="ssh-key"
              value={ssh.privateKeyPath}
              onChange={(privateKeyPath) => set({ privateKeyPath })}
              placeholder="e.g. ~/.ssh/id_ed25519"
              disabled={off}
            />
          </Field>
          <Field label="Key passphrase" htmlFor="ssh-passphrase">
            <Input
              id="ssh-passphrase"
              type="password"
              autoComplete="new-password"
              value={input.sshKeyPassphrase ?? ""}
              onChange={(e) => update("sshKeyPassphrase", e.target.value || null)}
              placeholder={
                editing?.sshTunnel?.privateKeyHasPassphrase ? KEEP_SAVED : "Only if the key is encrypted"
              }
              disabled={off}
            />
          </Field>
        </>
      )}
    </>
  );
}
