import * as api from "@client/api";
import { queryKeys } from "@client/lib/queryKeys";
import { toast } from "@client/lib/toast";
import { SettingsSectionFrame } from "@client/pages/settings/components/SettingsSectionFrame";
import type {
  McpAccessLevel,
  McpAccessSummary,
  McpTokenIssued,
  UpdateMcpAccessInput,
} from "@shared/types";
import {
  hashKey,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import type React from "react";
import { useEffect, useState } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Switch } from "@/components/ui/switch";
import { copyTextToClipboard } from "@/lib/utils";

type AgentAccessSectionProps = {
  layoutMode?: "accordion" | "panel";
};

const MCP_ACCESS_QUERY_KEY = queryKeys.mcpAccess.all;

function copyText(text: string, label: string) {
  void copyTextToClipboard(text).then(
    () => toast.success(`${label} copied`),
    () => toast.error(`${label} could not be copied`),
  );
}

export const AgentAccessSection: React.FC<AgentAccessSectionProps> = ({
  layoutMode,
}) => {
  const queryClient = useQueryClient();
  const {
    data: access,
    isLoading,
    isError,
  } = useQuery({
    queryKey: MCP_ACCESS_QUERY_KEY,
    queryFn: api.getMcpAccess,
  });
  // Kept in component state only and never written to the query cache; the
  // GET never carries it.
  const [token, setToken] = useState<string | null>(null);

  // Any re-read of the status (refetch, invalidation) drops
  // the token. The mutations below write the cache directly, which is not a
  // fetch, so they keep it.
  useEffect(
    () =>
      queryClient.getQueryCache().subscribe((event) => {
        if (
          event.type === "updated" &&
          event.action.type === "fetch" &&
          event.query.queryHash === hashKey(MCP_ACCESS_QUERY_KEY)
        ) {
          setToken(null);
        }
      }),
    [queryClient],
  );

  const generateMutation = useMutation({
    mutationFn: api.generateMcpToken,
    onMutate: () =>
      queryClient.cancelQueries({ queryKey: MCP_ACCESS_QUERY_KEY }),
    onSuccess: ({ token: issued, ...summary }: McpTokenIssued) => {
      queryClient.setQueryData<McpAccessSummary>(MCP_ACCESS_QUERY_KEY, summary);
      setToken(issued);
    },
    onError: (error: Error) => toast.error(error.message),
  });

  const updateMutation = useMutation({
    mutationFn: (input: UpdateMcpAccessInput) => api.updateMcpAccess(input),
    onSuccess: (next) => {
      queryClient.setQueryData(MCP_ACCESS_QUERY_KEY, next);
    },
    onError: (error: Error) => {
      toast.error(error.message);
      void queryClient.invalidateQueries({ queryKey: MCP_ACCESS_QUERY_KEY });
    },
  });

  const revokeMutation = useMutation({
    mutationFn: api.revokeMcpToken,
    onSuccess: (next) => {
      queryClient.setQueryData(MCP_ACCESS_QUERY_KEY, next);
      setToken(null);
      toast.success("Agent access revoked.");
    },
    onError: (error: Error) => toast.error(error.message),
  });

  const isBusy =
    generateMutation.isPending ||
    updateMutation.isPending ||
    revokeMutation.isPending;
  const enabled = access?.enabled ?? false;
  const controlsDisabled = !enabled || isBusy;
  const endpoint = `${window.location.origin}/mcp`;
  const command = token
    ? `claude mcp add --transport http cvclanker ${endpoint} --header "Authorization: Bearer ${token}"`
    : "";

  const status = !enabled
    ? "Off"
    : access?.createdAt
      ? `On since ${new Date(access.createdAt).toLocaleDateString()}`
      : "On";

  return (
    <SettingsSectionFrame
      mode={layoutMode}
      value="agent-access"
      title="Agent access"
    >
      {access && !access.webLoginEnabled ? (
        <Alert variant="warning">
          <AlertDescription>
            This app runs without its web login, so anyone who can reach this
            address can use the whole app, including generating a token here.
            The token limits only what the agent that has it can do. Turn the
            login on in Settings → Accounts & Access, or set BASIC_AUTH_USER and
            BASIC_AUTH_PASSWORD.
          </AlertDescription>
        </Alert>
      ) : null}

      {isLoading ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : isError ? (
        <p className="text-sm text-destructive">
          Could not read agent access. Reload to try again.
        </p>
      ) : (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border p-3">
            <div className="text-sm">
              <span className="font-medium">Status:</span> <span>{status}</span>
            </div>
            <div className="flex items-center gap-2">
              {enabled ? (
                <AlertDialog>
                  <AlertDialogTrigger asChild>
                    <Button type="button" size="sm" disabled={isBusy}>
                      Generate new token
                    </Button>
                  </AlertDialogTrigger>
                  <AlertDialogContent>
                    <AlertDialogHeader>
                      <AlertDialogTitle>Generate a new token?</AlertDialogTitle>
                      <AlertDialogDescription>
                        It replaces the current token, so the agent using it
                        loses access. Access goes back to read only, with the
                        personal brief not shared.
                      </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                      <AlertDialogCancel>Cancel</AlertDialogCancel>
                      <AlertDialogAction
                        onClick={() => generateMutation.mutate()}
                      >
                        Generate new token
                      </AlertDialogAction>
                    </AlertDialogFooter>
                  </AlertDialogContent>
                </AlertDialog>
              ) : (
                <Button
                  type="button"
                  size="sm"
                  disabled={isBusy}
                  onClick={() => generateMutation.mutate()}
                >
                  Generate token
                </Button>
              )}
              {enabled ? (
                <AlertDialog>
                  <AlertDialogTrigger asChild>
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      disabled={isBusy}
                    >
                      Revoke
                    </Button>
                  </AlertDialogTrigger>
                  <AlertDialogContent>
                    <AlertDialogHeader>
                      <AlertDialogTitle>Revoke agent access?</AlertDialogTitle>
                      <AlertDialogDescription>
                        The agent using this token loses access at once.
                      </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                      <AlertDialogCancel>Cancel</AlertDialogCancel>
                      <AlertDialogAction
                        onClick={() => revokeMutation.mutate()}
                      >
                        Revoke
                      </AlertDialogAction>
                    </AlertDialogFooter>
                  </AlertDialogContent>
                </AlertDialog>
              ) : null}
            </div>
          </div>

          {token ? (
            <div className="space-y-3 rounded-lg border p-3">
              <p className="text-sm font-medium">
                Copy the token now: it is shown only this once.
              </p>
              <div className="space-y-1">
                <Label htmlFor="agent-access-token" className="text-xs">
                  Token
                </Label>
                <div className="flex gap-2">
                  <Input
                    id="agent-access-token"
                    readOnly
                    value={token}
                    className="font-mono"
                  />
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() => copyText(token, "Token")}
                  >
                    Copy
                  </Button>
                </div>
              </div>
              <div className="space-y-1">
                <Label htmlFor="agent-access-endpoint" className="text-xs">
                  Address
                </Label>
                <Input
                  id="agent-access-endpoint"
                  readOnly
                  value={endpoint}
                  className="font-mono"
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="agent-access-command" className="text-xs">
                  Claude Code
                </Label>
                <div className="flex gap-2">
                  <Input
                    id="agent-access-command"
                    readOnly
                    value={command}
                    className="font-mono"
                  />
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() => copyText(command, "Command")}
                  >
                    Copy
                  </Button>
                </div>
              </div>
              <p className="text-xs text-muted-foreground">
                Other MCP clients take the same address and the header
                Authorization: Bearer followed by the token.
              </p>
            </div>
          ) : null}

          <div className="space-y-2">
            <div className="text-sm font-medium">Access</div>
            <RadioGroup
              value={access?.accessLevel ?? "read"}
              onValueChange={(value) =>
                updateMutation.mutate({ accessLevel: value as McpAccessLevel })
              }
              disabled={controlsDisabled}
              aria-label="Access"
            >
              <div className="flex items-center gap-2">
                <RadioGroupItem value="read" id="agent-access-read" />
                <Label htmlFor="agent-access-read">Read only</Label>
              </div>
              <div className="flex items-start gap-2">
                <RadioGroupItem
                  value="read_write"
                  id="agent-access-read-write"
                  className="mt-0.5"
                />
                <div className="space-y-1">
                  <Label htmlFor="agent-access-read-write">
                    Read and change
                  </Label>
                  <p className="text-xs text-muted-foreground">
                    The agent can mark a Ready job applied and add notes. A job
                    it marks applied can be moved back, but its applied mark
                    stays.
                  </p>
                </div>
              </div>
            </RadioGroup>
          </div>

          <div className="flex items-start gap-3">
            <Switch
              id="agent-access-share-brief"
              checked={access?.shareBrief ?? false}
              onCheckedChange={(checked) =>
                updateMutation.mutate({ shareBrief: checked })
              }
              disabled={controlsDisabled}
            />
            <div className="space-y-1">
              <Label htmlFor="agent-access-share-brief">
                Share the personal brief
              </Label>
              <p className="text-xs text-muted-foreground">
                The brief is the most personal text in the app.
              </p>
            </div>
          </div>

          <p className="text-xs text-muted-foreground">
            The token belongs to the current User Profile. After switching
            profile, generate one there.
          </p>
        </div>
      )}
    </SettingsSectionFrame>
  );
};
