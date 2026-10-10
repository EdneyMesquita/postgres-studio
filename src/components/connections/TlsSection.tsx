import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import type { SslMode } from "@/types/connection";
import { type ConnectionSectionProps } from "./connectionFormTypes";
import { Field } from "./Field";
import { FilePicker } from "./FilePicker";

const MODES: { value: SslMode; label: string; help: string }[] = [
  { value: "disable", label: "disable", help: "Never TLS. Only for servers on this machine or a trusted network." },
  { value: "prefer", label: "prefer", help: "TLS when the server offers it, without checking its certificate (libpq's default)." },
  { value: "require", label: "require", help: "Always TLS, without checking the certificate: encrypted, but not protected from impersonation." },
  { value: "verify-ca", label: "verify-ca", help: "Always TLS, with a certificate signed by a trusted authority, for any host name." },
  { value: "verify-full", label: "verify-full", help: "Always TLS, with a trusted certificate issued for this host. The safe choice for remote servers." },
];

export function TlsSection({ input, update }: ConnectionSectionProps) {
  const tls = input.tls;
  const mode = MODES.find((m) => m.value === tls.sslMode) ?? MODES[1];
  const verifies = tls.sslMode === "verify-ca" || tls.sslMode === "verify-full";
  return (
    <>
      <Field label="SSL mode" htmlFor="tls-mode" help={mode.help}>
        <Select value={tls.sslMode} onValueChange={(v) => update("tls", { ...tls, sslMode: v as SslMode })}>
          <SelectTrigger id="tls-mode" className="w-full font-data">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {MODES.map((m) => (
              <SelectItem key={m.value} value={m.value} className="font-data">
                {m.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>
      <Field
        label="Certificate authority"
        htmlFor="tls-ca"
        help={verifies ? "PEM file with the CA certificates to trust (sslrootcert); the system's when empty." : "Used with verify-ca and verify-full."}
      >
        <FilePicker id="tls-ca" value={tls.caFile} onChange={(caFile) => update("tls", { ...tls, caFile })} placeholder="System trust store" />
      </Field>
      <Field label="Client certificate" htmlFor="tls-cert" help="PEM certificate for certificate authentication (sslcert).">
        <FilePicker id="tls-cert" value={tls.certFile} onChange={(certFile) => update("tls", { ...tls, certFile })} placeholder="None" />
      </Field>
      <Field label="Client key" htmlFor="tls-key" help="Its PEM private key, unencrypted (sslkey).">
        <FilePicker id="tls-key" value={tls.keyFile} onChange={(keyFile) => update("tls", { ...tls, keyFile })} placeholder="None" />
      </Field>
    </>
  );
}
