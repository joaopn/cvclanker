import type { UpdateSettingsInput } from "@shared/settings-schema.js";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type React from "react";
import { FormProvider, useForm } from "react-hook-form";
import { afterEach, describe, expect, it } from "vitest";
import { THEME_STORAGE_KEY } from "@/lib/theme";
import { DisplaySettingsSection } from "./DisplaySettingsSection";

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
