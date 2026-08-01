import type React from "react";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  DARK_THEMES,
  type DarkThemeId,
  LIGHT_THEMES,
  type LightThemeId,
  type ThemePreference,
  useTheme,
} from "@/lib/theme";

const THEME_OPTIONS: Array<{ value: ThemePreference; label: string }> = [
  { value: "system", label: "System" },
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
];

// The ONE home of the theme picker, rendered by BOTH Settings -> Display and
// the onboarding wizard's finalize step, so the two cannot drift. Purely
// presentational over useTheme(): every control writes straight through to the
// per-device localStorage store and re-stamps the document, so there is nothing
// to save and no dirty state to thread — which is why the wizard can offer it
// without touching its step-completion predicate.
//
// DisplaySettingsSection.test.tsx passing UNCHANGED is this extraction's
// acceptance bar. It queries by label text and by the palette option's
// accessible name, so do NOT restructure the labels or the aria wiring here.
export const ThemeControls: React.FC = () => {
  const {
    preference,
    setPreference,
    lightTheme,
    darkTheme,
    setLightTheme,
    setDarkTheme,
  } = useTheme();

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-1.5">
        <span className="text-sm font-medium leading-none">Theme</span>
        <p className="text-xs text-muted-foreground">
          How CV Clanker looks in this browser. System follows your OS setting.
          The choice is stored on this device, not in your profile.
        </p>
        <RadioGroup
          aria-label="Theme"
          value={preference}
          onValueChange={(value) => setPreference(value as ThemePreference)}
          className="flex flex-wrap gap-x-6 gap-y-2 pt-1"
        >
          {THEME_OPTIONS.map((option) => (
            <div key={option.value} className="flex items-center space-x-2">
              <RadioGroupItem
                value={option.value}
                id={`theme-${option.value}`}
              />
              <label
                htmlFor={`theme-${option.value}`}
                className="text-sm font-medium leading-none cursor-pointer"
              >
                {option.label}
              </label>
            </div>
          ))}
        </RadioGroup>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="flex flex-col gap-1.5">
          <label
            htmlFor="theme-light-select"
            className="text-sm font-medium leading-none"
          >
            Light theme
          </label>
          <p className="text-xs text-muted-foreground">
            Used whenever the mode above resolves to light.
          </p>
          <Select
            value={lightTheme}
            onValueChange={(value) => setLightTheme(value as LightThemeId)}
          >
            <SelectTrigger id="theme-light-select">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {LIGHT_THEMES.map((theme) => (
                <SelectItem key={theme.id} value={theme.id}>
                  {theme.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="flex flex-col gap-1.5">
          <label
            htmlFor="theme-dark-select"
            className="text-sm font-medium leading-none"
          >
            Dark theme
          </label>
          <p className="text-xs text-muted-foreground">
            Used whenever the mode above resolves to dark.
          </p>
          <Select
            value={darkTheme}
            onValueChange={(value) => setDarkTheme(value as DarkThemeId)}
          >
            <SelectTrigger id="theme-dark-select">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {DARK_THEMES.map((theme) => (
                <SelectItem key={theme.id} value={theme.id}>
                  {theme.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>
    </div>
  );
};
