import {
  CV_SOURCE_FORMAT_NAMES,
  CV_SOURCE_FORMATS,
  type CvSourceFormat,
} from "@shared/types";
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
  {
    value: "html",
    title: "HTML",
    description:
      "A single .html page, or a .zip with the page and the files it uses. It must be self-contained: nothing loaded from the internet, no scripts. Tailoring rewrites the text in place and hands you back the page (or zip); its PDF is printed by Chromium.",
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
  // A first write of any format but LaTeX while a CV already exists is the
  // server's 409 — pre-empt it here rather than surfacing an error the user
  // can't act on.
  const blockedByExistingCv = !locked && hasExistingCv;

  return (
    <div className="space-y-6">
      <RadioGroup
        value={(locked ? storedFormat : choice) ?? ""}
        onValueChange={(value) =>
          onChoiceChange(
            CV_SOURCE_FORMATS.find((format) => format === value) ?? null,
          )
        }
        className="grid gap-4 xl:grid-cols-3"
      >
        {OPTIONS.map((option) => {
          const selected = (locked ? storedFormat : choice) === option.value;
          const disabled =
            isBusy ||
            locked ||
            (option.value !== "latex" && blockedByExistingCv);
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
                {option.value !== "latex" && blockedByExistingCv ? (
                  <div className="text-sm leading-6 text-status-warn-text">
                    This profile already has a LaTeX CV. Delete it, or start a
                    new user profile, to work in {option.title}.
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
            Format locked to{" "}
            {CV_SOURCE_FORMAT_NAMES[storedFormat] ??
              "a format this version does not know"}
          </AlertTitle>
          <AlertDescription>
            The CV format is fixed for this user profile. To work in another
            format, create a new user profile.
          </AlertDescription>
        </Alert>
      ) : null}
    </div>
  );
};
