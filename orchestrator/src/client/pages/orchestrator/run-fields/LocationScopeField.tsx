import type { LocationSearchScope } from "@shared/location-preferences.js";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { SEARCH_SCOPE_OPTIONS } from "../automatic-run";
import { getRadioOptionClassName } from "./helpers";

interface LocationScopeFieldProps {
  value: LocationSearchScope;
  onChange: (value: LocationSearchScope) => void;
}

export function LocationScopeField({
  value,
  onChange,
}: LocationScopeFieldProps) {
  return (
    <div className="space-y-3">
      <p className="text-xs font-semibold uppercase tracking-[0.18em] text-muted-foreground">
        Location scope
      </p>
      <RadioGroup
        value={value}
        onValueChange={(next) => onChange(next as LocationSearchScope)}
        className="gap-2"
      >
        {SEARCH_SCOPE_OPTIONS.map((option) => {
          const id = `search-scope-${option.value}`;
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
      {value !== "selected_only" ? (
        <p className="text-xs text-muted-foreground">
          The remote-worldwide half applies only to sources that report whether
          a job is remote: JobSpy (LinkedIn / Indeed / Glassdoor), startup.jobs
          and Working Nomads. The Apify LinkedIn actors and Hiring Cafe do not
          report it, so for those only your selected locations are kept.
        </p>
      ) : null}
    </div>
  );
}
