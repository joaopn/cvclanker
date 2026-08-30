import { Label } from "@/components/ui/label";
import { TokenizedInput } from "../TokenizedInput";

interface TokenizedFieldProps {
  id: string;
  /** When omitted, the bare TokenizedInput renders (e.g. inside a titled Card). */
  label?: string;
  labelClassName?: string;
  values: string[];
  draft: string;
  parseInput: (input: string) => string[];
  onDraftChange: (value: string) => void;
  onValuesChange: (values: string[]) => void;
  placeholder: string;
  removeLabelPrefix: string;
  helperText?: string;
  /** See TokenizedInput: must agree with `parseInput`. */
  commitKeys?: string[];
}

export function TokenizedField({
  id,
  label,
  labelClassName,
  values,
  draft,
  parseInput,
  onDraftChange,
  onValuesChange,
  placeholder,
  removeLabelPrefix,
  helperText,
  commitKeys,
}: TokenizedFieldProps) {
  const input = (
    <TokenizedInput
      id={id}
      values={values}
      draft={draft}
      parseInput={parseInput}
      onDraftChange={onDraftChange}
      onValuesChange={onValuesChange}
      placeholder={placeholder}
      removeLabelPrefix={removeLabelPrefix}
      helperText={helperText}
      commitKeys={commitKeys}
    />
  );

  if (!label) return input;

  return (
    <div className="space-y-2">
      <Label htmlFor={id} className={labelClassName}>
        {label}
      </Label>
      {input}
    </div>
  );
}
