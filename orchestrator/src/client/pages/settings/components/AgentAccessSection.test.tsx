import * as api from "@client/api";
import type { McpAccessSummary, McpTokenIssued } from "@shared/types";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AgentAccessSection } from "./AgentAccessSection";

vi.mock("@client/api", () => ({
  getMcpAccess: vi.fn(),
  generateMcpToken: vi.fn(),
  updateMcpAccess: vi.fn(),
  revokeMcpToken: vi.fn(),
}));
vi.mock("@client/lib/toast", () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}));

const OFF: McpAccessSummary = {
  enabled: false,
  accessLevel: "read",
  shareBrief: false,
  createdAt: null,
  webLoginEnabled: true,
};

const ON: McpAccessSummary = {
  enabled: true,
  accessLevel: "read",
  shareBrief: false,
  createdAt: "2026-11-20T10:00:00.000Z",
  webLoginEnabled: true,
};

const ISSUED: McpTokenIssued = { ...ON, token: "mcp-test-token-0001" };

function makeClient() {
  return new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
}

function renderSection(client = makeClient()) {
  const view = render(
    <QueryClientProvider client={client}>
      <AgentAccessSection layoutMode="panel" />
    </QueryClientProvider>,
  );
  return { client, ...view };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(api.getMcpAccess).mockResolvedValue(OFF);
  vi.mocked(api.generateMcpToken).mockResolvedValue(ISSUED);
  vi.mocked(api.updateMcpAccess).mockResolvedValue(ON);
  vi.mocked(api.revokeMcpToken).mockResolvedValue(OFF);
});

describe("AgentAccessSection", () => {
  it("shows Off with Generate, and keeps access and brief disabled", async () => {
    renderSection();

    expect(await screen.findByText("Off")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Generate token" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Revoke" }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "Read only" })).toBeDisabled();
    expect(
      screen.getByRole("radio", { name: "Read and change" }),
    ).toBeDisabled();
    expect(
      screen.getByRole("switch", { name: "Share the personal brief" }),
    ).toBeDisabled();
  });

  it("shows On since the token's date when on", async () => {
    vi.mocked(api.getMcpAccess).mockResolvedValue(ON);
    renderSection();

    const expected = `On since ${new Date(ON.createdAt as string).toLocaleDateString()}`;
    expect(await screen.findByText(expected)).toBeInTheDocument();
    expect(
      screen.getByRole("radio", { name: "Read and change" }),
    ).not.toBeDisabled();
  });

  it("shows the token, address and Claude Code command once, and drops them when the status is re-read", async () => {
    const { client } = renderSection();
    fireEvent.click(
      await screen.findByRole("button", { name: "Generate token" }),
    );

    const tokenField = await screen.findByLabelText<HTMLInputElement>("Token");
    expect(tokenField.value).toBe(ISSUED.token);
    expect(tokenField.readOnly).toBe(true);
    const endpoint = `${window.location.origin}/mcp`;
    expect(screen.getByLabelText<HTMLInputElement>("Address").value).toBe(
      endpoint,
    );
    expect(screen.getByLabelText<HTMLInputElement>("Claude Code").value).toBe(
      `claude mcp add --transport http cvclanker ${endpoint} --header "Authorization: Bearer ${ISSUED.token}"`,
    );
    expect(screen.getByText(/shown only this once/)).toBeInTheDocument();
    expect(api.generateMcpToken).toHaveBeenCalledTimes(1);

    // The cache holds the summary only; the token never rides in it.
    expect(client.getQueryData(["mcp-access"])).toEqual(ON);

    vi.mocked(api.getMcpAccess).mockResolvedValue(ON);
    await act(async () => {
      await client.invalidateQueries({ queryKey: ["mcp-access"] });
    });

    await waitFor(() => {
      expect(screen.queryByLabelText("Token")).not.toBeInTheDocument();
    });
    expect(screen.queryByText(ISSUED.token, { exact: false })).toBeNull();
    expect(api.getMcpAccess).toHaveBeenCalledTimes(2);
  });

  it("does not bring the token back after a remount", async () => {
    const { client, unmount } = renderSection();
    fireEvent.click(
      await screen.findByRole("button", { name: "Generate token" }),
    );
    expect(await screen.findByLabelText("Token")).toBeInTheDocument();

    unmount();
    vi.mocked(api.getMcpAccess).mockResolvedValue(ON);
    renderSection(client);

    expect(
      await screen.findByRole("button", { name: "Generate new token" }),
    ).toBeInTheDocument();
    expect(screen.queryByLabelText("Token")).not.toBeInTheDocument();
  });

  it("asks before generating a new token while on, and sends nothing when cancelled", async () => {
    vi.mocked(api.getMcpAccess).mockResolvedValue(ON);
    renderSection();

    fireEvent.click(
      await screen.findByRole("button", { name: "Generate new token" }),
    );
    expect(await screen.findByRole("alertdialog")).toBeInTheDocument();
    expect(api.generateMcpToken).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => {
      expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    });
    expect(api.generateMcpToken).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Generate new token" }));
    const dialog = await screen.findByRole("alertdialog");
    fireEvent.click(
      Array.from(dialog.querySelectorAll("button")).find(
        (button) => button.textContent === "Generate new token",
      ) as HTMLButtonElement,
    );
    await waitFor(() => {
      expect(api.generateMcpToken).toHaveBeenCalledTimes(1);
    });
    expect(await screen.findByLabelText("Token")).toBeInTheDocument();
  });

  it("sends the access choice and the brief switch as PATCHes", async () => {
    vi.mocked(api.getMcpAccess).mockResolvedValue(ON);
    vi.mocked(api.updateMcpAccess).mockResolvedValueOnce({
      ...ON,
      accessLevel: "read_write",
    });
    renderSection();

    fireEvent.click(
      await screen.findByRole("radio", { name: "Read and change" }),
    );
    await waitFor(() => {
      expect(api.updateMcpAccess).toHaveBeenCalledWith({
        accessLevel: "read_write",
      });
    });
    await waitFor(() => {
      expect(
        screen.getByRole("radio", { name: "Read and change" }),
      ).toBeChecked();
    });

    fireEvent.click(screen.getByRole("radio", { name: "Read only" }));
    await waitFor(() => {
      expect(api.updateMcpAccess).toHaveBeenLastCalledWith({
        accessLevel: "read",
      });
    });

    await waitFor(() => {
      expect(
        screen.getByRole("switch", { name: "Share the personal brief" }),
      ).not.toBeDisabled();
    });
    fireEvent.click(
      screen.getByRole("switch", { name: "Share the personal brief" }),
    );
    await waitFor(() => {
      expect(api.updateMcpAccess).toHaveBeenLastCalledWith({
        shareBrief: true,
      });
    });
    expect(api.updateMcpAccess).toHaveBeenCalledTimes(3);
  });

  it("asks before revoking: Cancel sends nothing, confirming sends DELETE and drops the token", async () => {
    renderSection();
    fireEvent.click(
      await screen.findByRole("button", { name: "Generate token" }),
    );
    expect(await screen.findByLabelText("Token")).toBeInTheDocument();

    fireEvent.click(await screen.findByRole("button", { name: "Revoke" }));
    expect(await screen.findByRole("alertdialog")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => {
      expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    });
    expect(api.revokeMcpToken).not.toHaveBeenCalled();
    expect(screen.getByLabelText("Token")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Revoke" }));
    const dialog = await screen.findByRole("alertdialog");
    fireEvent.click(
      Array.from(dialog.querySelectorAll("button")).find(
        (button) => button.textContent === "Revoke",
      ) as HTMLButtonElement,
    );
    await waitFor(() => {
      expect(api.revokeMcpToken).toHaveBeenCalledTimes(1);
    });
    expect(await screen.findByText("Off")).toBeInTheDocument();
    expect(screen.queryByLabelText("Token")).not.toBeInTheDocument();
  });

  it("offers no Generate, Revoke or controls when the status cannot be read", async () => {
    vi.mocked(api.getMcpAccess).mockRejectedValue(new Error("boom"));
    renderSection();

    expect(
      await screen.findByText(
        "Could not read agent access. Reload to try again.",
      ),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.queryByRole("radio")).toBeNull();
    expect(screen.queryByRole("switch")).toBeNull();
  });

  it("keeps the generated status when an older read lands after it", async () => {
    const { client } = renderSection();
    expect(await screen.findByText("Off")).toBeInTheDocument();

    let resolveStale: (value: McpAccessSummary) => void = () => {};
    vi.mocked(api.getMcpAccess).mockImplementationOnce(
      () =>
        new Promise<McpAccessSummary>((resolve) => {
          resolveStale = resolve;
        }),
    );
    act(() => {
      void client.invalidateQueries({ queryKey: ["mcp-access"] });
    });
    await waitFor(() => {
      expect(api.getMcpAccess).toHaveBeenCalledTimes(2);
    });

    fireEvent.click(screen.getByRole("button", { name: "Generate token" }));
    expect(await screen.findByLabelText("Token")).toBeInTheDocument();

    // The cache asserts what landed; the timeout flush lets React Query's
    // batched notify reach the component before the screen is read.
    await act(async () => {
      resolveStale(OFF);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await waitFor(() => {
      expect(client.getQueryState(["mcp-access"])?.fetchStatus).toBe("idle");
    });
    expect(client.getQueryData(["mcp-access"])).toEqual(ON);
    const expected = `On since ${new Date(ON.createdAt as string).toLocaleDateString()}`;
    expect(screen.getByText(expected)).toBeInTheDocument();
    expect(screen.queryByText("Off")).toBeNull();
  });

  it("re-reads the status when a change is refused", async () => {
    vi.mocked(api.getMcpAccess).mockResolvedValue(ON);
    vi.mocked(api.updateMcpAccess).mockRejectedValue(new Error("not found"));
    renderSection();

    fireEvent.click(
      await screen.findByRole("radio", { name: "Read and change" }),
    );
    vi.mocked(api.getMcpAccess).mockResolvedValue(OFF);

    expect(await screen.findByText("Off")).toBeInTheDocument();
    expect(api.getMcpAccess).toHaveBeenCalledTimes(2);
  });

  it("warns about the missing web login only when it is off", async () => {
    vi.mocked(api.getMcpAccess).mockResolvedValue({
      ...OFF,
      webLoginEnabled: false,
    });
    const first = renderSection();
    expect(
      await screen.findByText(/runs without its web login/),
    ).toBeInTheDocument();
    expect(screen.getByText(/BASIC_AUTH_USER/)).toBeInTheDocument();
    first.unmount();

    vi.mocked(api.getMcpAccess).mockResolvedValue(OFF);
    renderSection();
    expect(await screen.findByText("Off")).toBeInTheDocument();
    expect(screen.queryByText(/runs without its web login/)).toBeNull();
  });
});
