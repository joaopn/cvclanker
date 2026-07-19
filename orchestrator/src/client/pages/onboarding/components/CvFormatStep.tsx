import type { CvSourceFormat } from "@shared/types";
import { Lock } from "lucide-react";
import type React from "react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { cn } from "@/lib/utils";
import type { CvFormatChoice } from "../types";

const OPTIONS: {
  value: CvSourceFormat;
  title: string;
  description: string;
}[] = [
  {
    value: "latex",
    title: "LaTeX",
    description:
      "A .tex file, or a .zip with main.tex plus its class files, fonts, and images. Tailored CVs compile with tectonic.",
  },
  {
    value: "docx",
    title: "Word",
    description:
      "A .docx file. Tailoring rewrites the text in place and hands you back a .docx — your layout, styles, and fonts are untouched.",
  },
];

interface CvFormatStepProps {
  choice: CvFormatChoice;
  hasExistingCv: boolean;
  isBusy: boolean;
  onChoiceChange: (choice: CvFormatChoice) => void;
  storedFormat: CvSourceFormat | null;
}

export const CvFormatStep: React.FC<CvFormatStepProps> = ({
  choice,
  hasExistingCv,
  isBusy,
  onChoiceChange,
  storedFormat,
}) => {
  const locked = storedFormat !== null;
  // A first write of "docx" while a CV already exists is the server's 409 —
  // pre-empt it here rather than surfacing an error the user can't act on.
  const wordBlockedByExistingCv = !locked && hasExistingCv;

  return (
    <div className="space-y-6">
      <RadioGroup
        value={(locked ? storedFormat : choice) ?? ""}
        onValueChange={(value) =>
          onChoiceChange(value === "latex" || value === "docx" ? value : null)
        }
        className="grid gap-4 lg:grid-cols-2"
      >
        {OPTIONS.map((option) => {
          const selected = (locked ? storedFormat : choice) === option.value;
          const disabled =
            isBusy ||
            locked ||
            (option.value === "docx" && wordBlockedByExistingCv);
          const radioId = `cv-format-${option.value}`;
          return (
            <label
              key={option.value}
              htmlFor={radioId}
              className={cn(
                "flex items-start gap-4 rounded-lg border p-4 transition-colors",
                disabled ? "cursor-not-allowed opacity-60" : "cursor-pointer",
                selected
                  ? "border-primary bg-muted/40"
                  : !disabled && "border-border/60 hover:bg-muted/20",
                !selected && disabled && "border-border/60",
              )}
            >
              <RadioGroupItem
                id={radioId}
                value={option.value}
                className="mt-1"
                disabled={disabled}
              />
              <div className="space-y-1">
                <div className="text-base font-medium text-foreground">
                  {option.title}
                </div>
                <div className="text-sm leading-6 text-muted-foreground">
                  {option.description}
                </div>
                {option.value === "docx" && wordBlockedByExistingCv ? (
                  <div className="text-sm leading-6 text-status-warn-text">
                    This profile already has a LaTeX CV. Delete it, or start a
                    new user profile, to work in Word.
                  </div>
                ) : null}
              </div>
            </label>
          );
        })}
      </RadioGroup>

      {locked ? (
        <Alert>
          <Lock className="h-4 w-4" />
          <AlertTitle>
            Format locked to {storedFormat === "docx" ? "Word" : "LaTeX"}
          </AlertTitle>
          <AlertDescription>
            The CV format is fixed for this user profile. To work with the other
            format, create a new user profile.
          </AlertDescription>
        </Alert>
      ) : null}
    </div>
  );
};
