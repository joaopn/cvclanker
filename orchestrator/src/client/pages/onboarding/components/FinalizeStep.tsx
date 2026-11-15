import { CandidateNameInput } from "@client/components/CandidateNameInput";
import { ThemeControls } from "@client/components/ThemeControls";
import type React from "react";
import { Separator } from "@/components/ui/separator";
import type { BasicAuthChoice } from "../types";
import { BasicAuthStep } from "./BasicAuthStep";

// The wizard's last step: the basic-auth decision, the candidate's name and the
// theme picker.
//
// The primary button drives handleCompleteBasicAuth, which saves the auth
// decision and the name in one request; step completion still keys on the
// stored basic-auth decision alone, since the name is optional. ThemeControls
// writes per-device localStorage on every change and re-stamps the document
// immediately, so appearance needs no save and deliberately does NOT feed the
// completion predicate: gating on it would push every existing install back
// through onboarding, and there is no server-side value to check in the first
// place.
export const FinalizeStep: React.FC<{
  basicAuthChoice: BasicAuthChoice;
  basicAuthPassword: string;
  basicAuthUser: string;
  candidateName: string;
  isBusy: boolean;
  onBasicAuthChoiceChange: (choice: BasicAuthChoice) => void;
  onBasicAuthPasswordChange: (value: string) => void;
  onBasicAuthUserChange: (value: string) => void;
  onCandidateNameChange: (value: string) => void;
}> = ({
  basicAuthChoice,
  basicAuthPassword,
  basicAuthUser,
  candidateName,
  isBusy,
  onBasicAuthChoiceChange,
  onBasicAuthPasswordChange,
  onBasicAuthUserChange,
  onCandidateNameChange,
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
      <CandidateNameInput
        value={candidateName}
        onChange={onCandidateNameChange}
        disabled={isBusy}
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
