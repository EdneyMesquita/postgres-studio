import { RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { emptyAdvancedOptions, type ConnectionAdvancedOptions } from "@/types/connection";
import { DATA_FIELD, numberOrNull, type ConnectionSectionProps } from "./connectionFormTypes";
import { Field } from "./Field";
import { FieldRow } from "./FieldRow";
import { SwitchField } from "./SwitchField";

type NumberKey = "connectTimeoutMs" | "statementTimeoutMs";
type TextKey = "appName" | "searchPath";

export function AdvancedSection({ input, update }: ConnectionSectionProps) {
  const advanced = input.advanced;
  const set = (patch: Partial<ConnectionAdvancedOptions>) => update("advanced", { ...advanced, ...patch });

  const text = (key: TextKey, id: string, label: string, placeholder?: string, help?: string) => (
    <Field label={label} htmlFor={id} help={help}>
      <Input
        id={id}
        className={DATA_FIELD}
        spellCheck={false}
        value={advanced[key] ?? ""}
        onChange={(e) => set({ [key]: e.target.value || null })}
        placeholder={placeholder}
      />
    </Field>
  );
  const number = (key: NumberKey, id: string, label: string, placeholder?: string, help?: string) => (
    <Field label={label} htmlFor={id} help={help}>
      <Input
        id={id}
        className={DATA_FIELD}
        type="number"
        min={0}
        value={advanced[key] ?? ""}
        onChange={(e) => set({ [key]: numberOrNull(e.target.value) })}
        placeholder={placeholder}
      />
    </Field>
  );

  return (
    <>
      <SwitchField
        label="Read-only"
        description="Every session starts with default_transaction_read_only, so edits and writes from the app are refused. A guard against accidents on production, not a permission."
        checked={advanced.readOnly}
        onCheckedChange={(readOnly) => set({ readOnly })}
      />
      <SwitchField
        label="Pooler in transaction mode"
        description="For PgBouncer or Supabase's pooler (port 6543): no prepared statements and no session settings, which such poolers break. Column types then show as unknown."
        checked={advanced.poolerMode}
        onCheckedChange={(poolerMode) => set({ poolerMode })}
      />
      <SwitchField
        label="Show system schemas"
        description="List pg_catalog, information_schema and the like in the explorer."
        checked={advanced.showSystemSchemas}
        onCheckedChange={(showSystemSchemas) => set({ showSystemSchemas })}
      />
      <FieldRow>
        {number("statementTimeoutMs", "adv-stmt", "Statement timeout (ms)", "None", "statement_timeout for every session")}
        {number("connectTimeoutMs", "adv-cto", "Connect timeout (ms)", "10000")}
      </FieldRow>
      <FieldRow>
        {text("searchPath", "adv-search-path", "Search path", "\"$user\", public")}
        {text("appName", "adv-app-name", "Application name", "Postgres Studio", "Shown in pg_stat_activity")}
      </FieldRow>
      <Button variant="ghost" size="sm" className="self-start" onClick={() => update("advanced", emptyAdvancedOptions())}>
        <RotateCcw />
        Reset advanced options
      </Button>
    </>
  );
}
