import {
  SUITABILITY_CATEGORY_LABELS,
  type SuitabilityCategory,
} from "@shared/types";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { getRadioOptionClassName } from "./helpers";

interface MinFitFieldProps {
  value: SuitabilityCategory;
  onChange: (value: SuitabilityCategory) => void;
}

export function MinFitField({ value, onChange }: MinFitFieldProps) {
  return (
    <div className="space-y-2">
      <Label>Min suitability</Label>
      <RadioGroup
        value={value}
        onValueChange={(next) => onChange(next as SuitabilityCategory)}
        className="gap-2"
      >
        {(
          [
            "great_fit",
            "very_good_fit",
            "good_fit",
            "bad_fit",
          ] as const satisfies readonly SuitabilityCategory[]
        ).map((category) => {
          const id = `min-category-${category}`;
          const selected = value === category;
          return (
            <label
              key={category}
              htmlFor={id}
              className={getRadioOptionClassName(selected)}
            >
              <RadioGroupItem value={category} id={id} />
              <span className="text-sm font-medium">
                {SUITABILITY_CATEGORY_LABELS[category]}
                {category === "great_fit"
                  ? ""
                  : category === "bad_fit"
                    ? " (everything)"
                    : " (and better)"}
              </span>
            </label>
          );
        })}
      </RadioGroup>
    </div>
  );
}
