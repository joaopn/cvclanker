import type { LocationMatchStrictness } from "@shared/location-preferences.js";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { MATCH_STRICTNESS_OPTIONS } from "../automatic-run";
import { getRadioOptionClassName } from "./helpers";

interface MatchStrictnessFieldProps {
  value: LocationMatchStrictness;
  onChange: (value: LocationMatchStrictness) => void;
  /**
   * Whether a country is selected, and whether any city is listed. Both are
   * EMPTY on a new profile — which is exactly the state the onboarding wizard
   * renders this copy in — and in either of those states the setting does
   * nothing at all, so the help text has to say so rather than describe a
   * filter that is not running.
   */
  hasCountry: boolean;
  hasCities: boolean;
}

function helpText(
  value: LocationMatchStrictness,
  hasCountry: boolean,
  hasCities: boolean,
): string {
  if (!hasCountry) {
    return "No country selected, so no location filtering happens at all and this setting has no effect yet.";
  }
  if (!hasCities) {
    return "No cities listed, so the whole country is searched and every job in it is kept. This setting only starts to matter once you add a city.";
  }
  return value === "exact_only"
    ? "A job must name one of your cities or it is dropped — including the neighbouring towns a board returns because it resolves a city to a radius, and postings listed for the whole country rather than a city. Those rows are still scraped and paid for before being discarded. A job the source flags as remote can still be kept, if the location scope above allows remote worldwide."
    : "Cities decide where the boards search but do not filter what comes back: every job in your selected country is kept, neighbouring towns and country-wide postings included. Each extra job kept costs one scoring call. A location naming no country at all is also kept, so a metro name from elsewhere can slip through.";
}

export function MatchStrictnessField({
  value,
  onChange,
  hasCountry,
  hasCities,
}: MatchStrictnessFieldProps) {
  return (
    <div className="space-y-3">
      <p className="text-xs font-semibold uppercase tracking-[0.18em] text-muted-foreground">
        Match strictness
      </p>
      <RadioGroup
        value={value}
        onValueChange={(next) => onChange(next as LocationMatchStrictness)}
        className="gap-2"
      >
        {MATCH_STRICTNESS_OPTIONS.map((option) => {
          const id = `match-strictness-${option.value}`;
          const selected = value === option.value;
          return (
            <label
              key={option.value}
              htmlFor={id}
              className={getRadioOptionClassName(selected)}
            >
              <RadioGroupItem value={option.value} id={id} />
              <span className="text-sm font-medium">{option.label}</span>
            </label>
          );
        })}
      </RadioGroup>
      <p className="text-xs text-muted-foreground">
        {helpText(value, hasCountry, hasCities)}
      </p>
    </div>
  );
}
