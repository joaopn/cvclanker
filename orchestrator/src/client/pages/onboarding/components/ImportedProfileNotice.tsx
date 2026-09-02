import { consumeImportedProfileNotice } from "@client/lib/importedProfileNotice";
import { Database } from "lucide-react";
import type React from "react";
import { useState } from "react";

/**
 * Explains why the wizard is still on screen after a database import.
 *
 * Everything an import carries — jobs, CVs, search profiles, sources, settings
 * — lands and marks its step complete. Only the credentials can be missing,
 * because an export taken without secrets has them stripped. Without this the
 * restart looks like the import did nothing at all.
 */
export const ImportedProfileNotice: React.FC = () => {
  // Read once, during the first render: an effect would flash the page without
  // it, and the notice is consumed so a reload does not repeat it.
  const [name] = useState(() => consumeImportedProfileNotice());
  if (name === null) return null;

  return (
    <div className="flex items-start gap-3 rounded-lg border border-border/60 bg-muted/30 px-4 py-3">
      <Database className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
      <div className="space-y-1 text-sm">
        <p className="font-medium">Imported &quot;{name}&quot;</p>
        <p className="text-muted-foreground">
          Its jobs, CVs, search profiles and settings are live now. Any step
          below that is still incomplete needs something the file did not carry
          — usually an API key, which an export only includes when &quot;Include
          API keys &amp; secrets&quot; was ticked.
        </p>
      </div>
    </div>
  );
};
