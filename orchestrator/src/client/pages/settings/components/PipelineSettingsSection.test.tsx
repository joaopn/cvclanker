import type { UpdateSettingsInput } from "@shared/settings-schema.js";
import type { SuitabilityCategory } from "@shared/types.js";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import React from "react";
import { FormProvider, useForm } from "react-hook-form";
import { describe, expect, it, vi } from "vitest";

// Radix Select can't open in jsdom (no pointer capture). Mock it to a plain
// button-per-item shell — this validates PipelineSettingsSection's value
// mapping, not Radix behaviour.
vi.mock("@/components/ui/select", () => {
  const SelectContext = React.createContext<{
    onValueChange?: (value: string) => void;
  } | null>(null);
  return {
    Select: ({
      children,
      value,
      onValueChange,
    }: {
      children: React.ReactNode;
      value?: string;
      onValueChange?: (value: string) => void;
    }) => (
      <SelectContext.Provider value={{ onValueChange }}>
        <div>
          <input readOnly value={value ?? ""} aria-label="select-value" />
          {children}
        </div>
      </SelectContext.Provider>
    ),
    SelectContent: ({ children }: { children: React.ReactNode }) => (
      <>{children}</>
    ),
    SelectItem: ({
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
    },
    SelectTrigger: ({
      children,
      ...props
    }: React.ButtonHTMLAttributes<HTMLButtonElement>) => (
      <button type="button" {...props}>
        {children}
      </button>
    ),
    SelectValue: () => null,
  };
});

import { Accordion } from "@/components/ui/accordion";
import { PipelineSettingsSection } from "./PipelineSettingsSection";

const PipelineSettingsHarness = ({
  mode = "onSubmit" as const,
  autoSkipCategory = null,
}: {
  mode?: "onSubmit" | "onChange";
  autoSkipCategory?: SuitabilityCategory | null;
} = {}) => {
  const methods = useForm<UpdateSettingsInput>({
    mode,
    defaultValues: {
      autoTailoringEnabled: null,
      enableJobScoring: null,
      autoSkipCategory,
      scoringInstructions: "",
      inboxStaleThresholdDays: null,
      maxBulkActionJobs: null,
      llmRateLimitRetries: null,
      discoveryConcurrency: null,
      scoringConcurrency: null,
      tailoringConcurrency: null,
      bulkActionConcurrency: null,
      batchUrlImportConcurrency: null,
      manualJobFetchTimeoutMs: null,
      manualJobFetchMinExtractedChars: null,
      manualJobFetchBrowserSettleMs: null,
      maxCvUploadBytes: null,
      maxCoverLetterUploadBytes: null,
      maxExpandedLatexBytes: null,
    },
  });

  return (
    <FormProvider {...methods}>
      <Accordion type="multiple" defaultValue={["pipeline"]}>
        <PipelineSettingsSection
          values={{
            autoTailoringEnabled: { effective: false, default: false },
            enableJobScoring: { effective: true, default: true },
            autoSkipCategory: { effective: null, default: null },
            scoringInstructions: {
              effective: "Calibration: ties go to the more generous tier.",
              default: "Calibration: ties go to the more generous tier.",
            },
            inboxStaleThresholdDays: { effective: 7, default: 7 },
            maxBulkActionJobs: { effective: 1000, default: 1000 },
            llmRateLimitRetries: { effective: 3, default: 3 },
            discoveryConcurrency: { effective: 3, default: 3 },
            scoringConcurrency: { effective: 4, default: 4 },
            tailoringConcurrency: { effective: 3, default: 3 },
            bulkActionConcurrency: { effective: 5, default: 5 },
            batchUrlImportConcurrency: { effective: 3, default: 3 },
            manualJobFetchTimeoutMs: { effective: 20_000, default: 20_000 },
            manualJobFetchMinExtractedChars: { effective: 200, default: 200 },
            manualJobFetchBrowserSettleMs: { effective: 4000, default: 4000 },
            maxCvUploadBytes: { effective: 10_485_760, default: 10_485_760 },
            maxCoverLetterUploadBytes: {
              effective: 10_485_760,
              default: 10_485_760,
            },
            maxExpandedLatexBytes: {
              effective: 10_485_760,
              default: 10_485_760,
            },
          }}
          isLoading={false}
          isSaving={false}
        />
      </Accordion>
      <output data-testid="form-auto-skip">
        {String(methods.watch("autoSkipCategory"))}
      </output>
    </FormProvider>
  );
};

describe("PipelineSettingsSection", () => {
  it("renders the scoring instructions textarea and binds typed input", () => {
    render(<PipelineSettingsHarness />);

    const textarea = screen.getByLabelText("Scoring policy");
    expect(textarea).toHaveAttribute(
      "placeholder",
      "Calibration: ties go to the more generous tier.",
    );
    fireEvent.change(textarea, {
      target: { value: "Prefer remote roles; on-site abroad is a bad fit." },
    });

    expect(
      screen.getByDisplayValue(
        "Prefer remote roles; on-site abroad is a bad fit.",
      ),
    ).toBeInTheDocument();
  });

  it("rejects a policy over the 16000-char cap", async () => {
    render(<PipelineSettingsHarness mode="onChange" />);

    const textarea = screen.getByLabelText("Scoring policy");
    fireEvent.change(textarea, { target: { value: "x".repeat(16001) } });

    await waitFor(() => {
      expect(
        screen.getByText("Must be at most 16000 characters"),
      ).toBeInTheDocument();
    });
  });
  it("stores the picked tier, and null for Off", () => {
    render(<PipelineSettingsHarness />);

    // Default is off — the disabled state must be a real null, not the "off"
    // sentinel, because null is what the API stores to disable the rule.
    expect(screen.getByTestId("form-auto-skip")).toHaveTextContent("null");
    // …and the other direction: null must display AS the sentinel, or the
    // trigger falls back to a blank/placeholder instead of showing "Off".
    expect(screen.getByLabelText("select-value")).toHaveValue("off");

    fireEvent.click(screen.getByText("Bad fit and worse"));
    expect(screen.getByTestId("form-auto-skip")).toHaveTextContent("bad_fit");
    expect(screen.getByLabelText("select-value")).toHaveValue("bad_fit");

    fireEvent.click(
      screen.getByText("Off — every scored job lands in the Inbox"),
    );
    expect(screen.getByTestId("form-auto-skip")).toHaveTextContent("null");
  });

  it("never offers to auto-skip the top tier", () => {
    render(<PipelineSettingsHarness />);

    expect(screen.getByText("Bad fit and worse")).toBeInTheDocument();
    expect(screen.getByText("Very good fit and worse")).toBeInTheDocument();
    expect(screen.queryByText("Great fit and worse")).not.toBeInTheDocument();
  });

  it("shows Off as the current value when unset", () => {
    render(<PipelineSettingsHarness />);

    expect(screen.getByText("Off")).toBeInTheDocument();
  });
  it("still shows a tier the control doesn't offer but the API accepts", () => {
    render(<PipelineSettingsHarness autoSkipCategory="great_fit" />);

    // Without a matching item the trigger renders blank, hiding a rule that is
    // actually in force.
    expect(screen.getByLabelText("select-value")).toHaveValue("great_fit");
    expect(screen.getAllByText("Great fit and worse").length).toBeGreaterThan(
      0,
    );
  });
});
