import type { UpdateSettingsInput } from "@shared/settings-schema.js";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import React from "react";
import { FormProvider, useForm } from "react-hook-form";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DARK_THEME_STORAGE_KEY,
  LIGHT_THEME_STORAGE_KEY,
  THEME_STORAGE_KEY,
} from "@/lib/theme";
import { DisplaySettingsSection } from "./DisplaySettingsSection";

// The real Radix Select can't open in jsdom (no pointer-capture /
// scrollIntoView stubs). This shell differs from ProfileSelect.test.tsx's on
// purpose: that one probes the value through a single aria-label="select-value"
// input, which collides once a page renders TWO selects. Here the trigger
// itself renders the current value and keeps its own aria-label, so each
// dropdown is addressable independently.
vi.mock("@/components/ui/select", () => {
  const SelectContext = React.createContext<{
    value?: string;
    onValueChange?: (value: string) => void;
  } | null>(null);

  const Select = ({
    children,
    value,
    onValueChange,
  }: {
    children: React.ReactNode;
    value?: string;
    onValueChange?: (value: string) => void;
  }) => (
    <SelectContext.Provider value={{ value, onValueChange }}>
      <div>{children}</div>
    </SelectContext.Provider>
  );

  const SelectContent = ({ children }: { children: React.ReactNode }) => (
    <>{children}</>
  );

  const SelectValue = () => null;

  const SelectItem = ({
    value,
    children,
  }: {
    value: string;
    children: React.ReactNode;
  }) => {
    const context = React.useContext(SelectContext);
    return (
      <button type="button" onClick={() => context?.onValueChange?.(value)}>
        {children}
      </button>
    );
  };

  const SelectTrigger = ({
    children: _children,
    ...props
  }: React.ButtonHTMLAttributes<HTMLButtonElement>) => {
    const context = React.useContext(SelectContext);
    return (
      <button type="button" role="combobox" aria-expanded="false" {...props}>
        {context?.value ?? ""}
      </button>
    );
  };

  return { Select, SelectContent, SelectItem, SelectTrigger, SelectValue };
});

const Wrapper: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const form = useForm<UpdateSettingsInput>();
  return <FormProvider {...form}>{children}</FormProvider>;
};

function renderSection() {
  return render(
    <DisplaySettingsSection
      values={{
        showSponsorInfo: { effective: false, default: false },
        renderMarkdownInJobDescriptions: { effective: true, default: true },
      }}
      isLoading={false}
      isSaving={false}
      layoutMode="panel"
    />,
    { wrapper: Wrapper },
  );
}

afterEach(() => {
  cleanup();
  window.localStorage.clear();
  document.documentElement.classList.remove("dark");
  document.documentElement.removeAttribute("data-theme");
});

describe("DisplaySettingsSection theme control", () => {
  it("persists an explicit choice and stamps the html class", () => {
    renderSection();

    fireEvent.click(screen.getByRole("radio", { name: "Dark" }));
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe("dark");
    expect(document.documentElement.classList.contains("dark")).toBe(true);
    expect(
      screen.getByRole("radio", { name: "Dark" }).getAttribute("aria-checked"),
    ).toBe("true");

    fireEvent.click(screen.getByRole("radio", { name: "Light" }));
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe("light");
    expect(document.documentElement.classList.contains("dark")).toBe(false);
  });

  it("selecting System clears the stored key", () => {
    window.localStorage.setItem(THEME_STORAGE_KEY, "dark");
    renderSection();

    expect(
      screen.getByRole("radio", { name: "Dark" }).getAttribute("aria-checked"),
    ).toBe("true");

    fireEvent.click(screen.getByRole("radio", { name: "System" }));
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBeNull();
    expect(
      screen
        .getByRole("radio", { name: "System" })
        .getAttribute("aria-checked"),
    ).toBe("true");
  });
});

describe("DisplaySettingsSection palette dropdowns", () => {
  it("shows each slot's current palette independently", () => {
    window.localStorage.setItem(LIGHT_THEME_STORAGE_KEY, "newsprint");
    window.localStorage.setItem(DARK_THEME_STORAGE_KEY, "forest-amber");
    renderSection();

    expect(screen.getByLabelText("Light theme")).toHaveTextContent("newsprint");
    expect(screen.getByLabelText("Dark theme")).toHaveTextContent(
      "forest-amber",
    );
  });

  it("picking a light palette persists it and restamps while light is active", () => {
    window.localStorage.setItem(THEME_STORAGE_KEY, "light");
    renderSection();

    fireEvent.click(screen.getByRole("button", { name: "Ice" }));

    expect(window.localStorage.getItem(LIGHT_THEME_STORAGE_KEY)).toBe("ice");
    expect(document.documentElement.getAttribute("data-theme")).toBe("ice");
    expect(screen.getByLabelText("Light theme")).toHaveTextContent("ice");
  });

  it("picking a dark palette persists it and restamps while dark is active", () => {
    window.localStorage.setItem(THEME_STORAGE_KEY, "dark");
    renderSection();

    fireEvent.click(screen.getByRole("button", { name: "Slate Blue" }));

    expect(window.localStorage.getItem(DARK_THEME_STORAGE_KEY)).toBe(
      "slate-blue",
    );
    expect(document.documentElement.getAttribute("data-theme")).toBe(
      "slate-blue",
    );
  });

  it("changing the inactive slot persists without changing the stamped palette", () => {
    window.localStorage.setItem(THEME_STORAGE_KEY, "light");
    renderSection();

    fireEvent.click(screen.getByRole("button", { name: "Forest Amber" }));

    expect(window.localStorage.getItem(DARK_THEME_STORAGE_KEY)).toBe(
      "forest-amber",
    );
    // Light is the active mode, so the stamp stays on the light slot.
    expect(document.documentElement.getAttribute("data-theme")).toBe(
      "sandstone",
    );
  });
});
