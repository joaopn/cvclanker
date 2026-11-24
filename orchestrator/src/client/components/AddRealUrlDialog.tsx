import { toast } from "@client/lib/toast";
import { Link2, Loader2 } from "lucide-react";
import type React from "react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import * as api from "../api";

function isHttpUrl(value: string): boolean {
  try {
    const { protocol } = new URL(value);
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}

interface AddRealUrlDialogProps {
  jobId: string;
  onJobUpdated: () => void | Promise<void>;
  className?: string;
}

export const AddRealUrlDialog: React.FC<AddRealUrlDialogProps> = ({
  jobId,
  onJobUpdated,
  className,
}) => {
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);

  const handleOpenChange = (next: boolean) => {
    if (next) {
      setValue("");
      setError(null);
    }
    setOpen(next);
  };

  const handleSave = async () => {
    const url = value.trim();
    if (!isHttpUrl(url)) {
      setError("Enter a full http:// or https:// address.");
      return;
    }

    try {
      setError(null);
      setIsSaving(true);
      await api.updateJob(jobId, { applicationLink: url });
      await onJobUpdated();
      setOpen(false);
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Failed to save the address";
      toast.error(message);
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger asChild>
        <Button variant="outline" className={className}>
          <Link2 className="h-3.5 w-3.5 shrink-0" />
          <span>Add real URL</span>
        </Button>
      </DialogTrigger>
      <DialogContent onKeyDown={(event) => event.stopPropagation()}>
        <DialogHeader>
          <DialogTitle>Add real URL</DialogTitle>
          <DialogDescription>
            Paste the employer's application address. Open Job Listing will open
            it instead of LinkedIn.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-1">
          <Label htmlFor="add-real-url-input">Application address</Label>
          <Input
            id="add-real-url-input"
            value={value}
            placeholder="https://"
            onChange={(event) => setValue(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== "Enter" || isSaving) return;
              event.preventDefault();
              void handleSave();
            }}
          />
          {error && <p className="text-xs text-destructive">{error}</p>}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => handleOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={handleSave} disabled={isSaving}>
            {isSaving && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
