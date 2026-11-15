import { CANDIDATE_NAME_MAX_CHARS } from "@shared/settings-registry";
import type React from "react";
import { Input } from "@/components/ui/input";
import { buildDownloadFilename } from "@/lib/download-filename";

const EXAMPLE_COMPANY = "Acme Corp";

type CandidateNameInputProps = {
  value: string;
  onChange: (value: string) => void;
  onBlur?: () => void;
  disabled?: boolean;
};

export const CandidateNameInput: React.FC<CandidateNameInputProps> = ({
  value,
  onChange,
  onBlur,
  disabled,
}) => (
  <div className="space-y-2">
    <label htmlFor="candidateName" className="text-sm font-medium">
      Your name (optional)
    </label>
    <Input
      id="candidateName"
      name="candidateName"
      value={value}
      onChange={(event) => onChange(event.target.value)}
      onBlur={onBlur}
      maxLength={CANDIDATE_NAME_MAX_CHARS}
      autoComplete="name"
      placeholder="Jane Q. Doe"
      disabled={disabled}
    />
    <p className="text-xs text-muted-foreground">
      Used to name the CVs and cover letters you download: last name, initials,
      document and company. For a last name of more than one word, write it
      first followed by a comma: "García Márquez, Gabriel". Leave out titles
      such as Dr. or PhD.
    </p>
    <p className="text-xs text-muted-foreground">
      A CV for {EXAMPLE_COMPANY} downloads as{" "}
      <span
        className="break-all font-mono"
        data-testid="candidate-name-example"
      >
        {buildDownloadFilename({
          candidateName: value,
          kind: "resume",
          employer: EXAMPLE_COMPANY,
          ext: "pdf",
        })}
      </span>
    </p>
  </div>
);
