import { ThemeControls } from "@client/components/ThemeControls";
import type React from "react";
import { Separator } from "@/components/ui/separator";
import type { BasicAuthChoice } from "../types";
import { BasicAuthStep } from "./BasicAuthStep";

// The wizard's last step: the basic-auth decision plus the theme picker.
//
// Only the auth half is gated or persisted — the primary button still drives
// handleCompleteBasicAuth, and step completion still keys on the stored
// basic-auth decision. ThemeControls writes per-device localStorage on every
// change and re-stamps the document immediately, so appearance needs no save
// and deliberately does NOT feed the completion predicate: gating on it would
// push every existing install back through onboarding, and there is no
// server-side value to check in the first place.
export const FinalizeStep: React.FC<{
  basicAuthChoice: BasicAuthChoice;
  basicAuthPassword: string;
  basicAuthUser: string;
  isBusy: boolean;
  onBasicAuthChoiceChange: (choice: BasicAuthChoice) => void;
  onBasicAuthPasswordChange: (value: string) => void;
  onBasicAuthUserChange: (value: string) => void;
}> = ({
  basicAuthChoice,
  basicAuthPassword,
  basicAuthUser,
  isBusy,
  onBasicAuthChoiceChange,
  onBasicAuthPasswordChange,
  onBasicAuthUserChange,
}) => (
  <div className="space-y-8">
    <section className="space-y-4">
      <div className="space-y-1">
        <h3 className="text-base font-medium text-foreground">
          Secure your workspace
        </h3>
        <p className="text-sm leading-6 text-muted-foreground">
          Require sign-in before anyone can reach the protected parts of CV
          Clanker, or skip it and set it up later in Settings.
        </p>
      </div>
      <BasicAuthStep
        basicAuthChoice={basicAuthChoice}
        basicAuthPassword={basicAuthPassword}
        basicAuthUser={basicAuthUser}
        isBusy={isBusy}
        onBasicAuthChoiceChange={onBasicAuthChoiceChange}
        onBasicAuthPasswordChange={onBasicAuthPasswordChange}
        onBasicAuthUserChange={onBasicAuthUserChange}
      />
    </section>

    <Separator />

    <section className="space-y-4">
      <div className="space-y-1">
        <h3 className="text-base font-medium text-foreground">Appearance</h3>
        <p className="text-sm leading-6 text-muted-foreground">
          Pick how CV Clanker looks. This applies straight away — no need to
          save it — and you can change it any time from Settings.
        </p>
      </div>
      <ThemeControls />
    </section>
  </div>
);
