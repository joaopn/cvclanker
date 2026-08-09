import type { UpdateSettingsInput } from "@shared/settings-schema.js";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { FormProvider, useForm } from "react-hook-form";
import { describe, expect, it } from "vitest";
import { Accordion } from "@/components/ui/accordion";
import { PipelineSettingsSection } from "./PipelineSettingsSection";

const PipelineSettingsHarness = ({
  mode = "onSubmit" as const,
}: {
  mode?: "onSubmit" | "onChange";
} = {}) => {
  const methods = useForm<UpdateSettingsInput>({
    mode,
    defaultValues: {
      autoTailoringEnabled: null,
      enableJobScoring: null,
      scoringInstructions: "",
      inboxStaleThresholdDays: null,
      maxBulkActionJobs: null,
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
            scoringInstructions: {
              effective: "Calibration: ties go to the more generous tier.",
              default: "Calibration: ties go to the more generous tier.",
            },
            inboxStaleThresholdDays: { effective: 7, default: 7 },
            maxBulkActionJobs: { effective: 1000, default: 1000 },
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
});
