import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DARK_THEME_STORAGE_KEY,
  LIGHT_THEME_STORAGE_KEY,
  THEME_STORAGE_KEY,
} from "@/lib/theme";
import { FinalizeStep } from "./FinalizeStep";

afterEach(() => {
  cleanup();
  window.localStorage.clear();
  document.documentElement.classList.remove("dark");
  document.documentElement.removeAttribute("data-theme");
});

function renderStep(overrides?: {
  basicAuthChoice?: "enable" | "skip" | null;
}) {
  const handlers = {
    onBasicAuthChoiceChange: vi.fn(),
    onBasicAuthPasswordChange: vi.fn(),
    onBasicAuthUserChange: vi.fn(),
  };
  render(
    <FinalizeStep
      basicAuthChoice={overrides?.basicAuthChoice ?? "skip"}
      basicAuthPassword=""
      basicAuthUser=""
      isBusy={false}
      {...handlers}
    />,
  );
  return handlers;
}

describe("FinalizeStep", () => {
  // The whole point of the step: it is no longer auth-only. If a future edit
  // drops either half this fails, rather than silently shipping a step whose
  // heading promises two things and renders one.
  it("renders BOTH the auth decision and the theme controls", () => {
    renderStep();

    expect(screen.getByRole("radio", { name: /Lock it down/ })).toBeVisible();
    expect(screen.getByRole("radio", { name: /Skip for now/ })).toBeVisible();

    expect(screen.getByRole("radio", { name: "System" })).toBeVisible();
    expect(screen.getByRole("radio", { name: "Light" })).toBeVisible();
    expect(screen.getByRole("radio", { name: "Dark" })).toBeVisible();
    expect(screen.getByLabelText("Light theme")).toBeVisible();
    expect(screen.getByLabelText("Dark theme")).toBeVisible();
  });

  it("still wires the auth choice through after the composition", () => {
    const { onBasicAuthChoiceChange } = renderStep();

    fireEvent.click(screen.getByRole("radio", { name: /Lock it down/ }));
    expect(onBasicAuthChoiceChange).toHaveBeenCalledWith("enable");
  });

  it("reveals the credential fields only once auth is enabled", () => {
    renderStep({ basicAuthChoice: "skip" });
    expect(screen.queryByLabelText("Username")).toBeNull();

    cleanup();
    renderStep({ basicAuthChoice: "enable" });
    expect(screen.getByLabelText("Username")).toBeVisible();
    expect(screen.getByLabelText("Password")).toBeVisible();
  });

  // Appearance is per-device localStorage, so it applies on click with no save
  // step — that is what lets the wizard offer it without touching the
  // step-completion predicate. Pinned here because a regression would look like
  // "the control moved but stopped doing anything".
  it("applies a theme change immediately, with no save step", () => {
    renderStep();

    fireEvent.click(screen.getByRole("radio", { name: "Dark" }));

    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe("dark");
    expect(document.documentElement.classList.contains("dark")).toBe(true);
    expect(document.documentElement.getAttribute("data-theme")).toBe(
      "graphite-mono",
    );
  });

  it("does not persist any theme choice until the user makes one", () => {
    renderStep();

    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBeNull();
    expect(window.localStorage.getItem(LIGHT_THEME_STORAGE_KEY)).toBeNull();
    expect(window.localStorage.getItem(DARK_THEME_STORAGE_KEY)).toBeNull();
  });
});
