import { Maximize2 } from "lucide-react";
import type React from "react";
import { useRef } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";

export function readerSubtitle(job: { title: string; employer: string }) {
  return `${job.title} · ${job.employer}`;
}

interface ReaderDialogProps {
  title: string;
  subtitle: string;
  children: React.ReactNode;
}

export const ReaderDialog: React.FC<ReaderDialogProps> = ({
  title,
  subtitle,
  children,
}) => {
  const bodyRef = useRef<HTMLDivElement>(null);

  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button
          size="icon"
          variant="ghost"
          className="h-8 w-8"
          aria-label="Open in reader"
          title="Open in reader"
        >
          <Maximize2 className="h-3.5 w-3.5" />
        </Button>
      </DialogTrigger>
      <DialogContent
        className="flex max-h-[85vh] w-[1200px] max-w-[calc(100vw-2rem)] flex-col gap-4"
        onKeyDown={(event) => event.stopPropagation()}
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          bodyRef.current?.focus();
        }}
      >
        <DialogHeader className="pr-6">
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{subtitle}</DialogDescription>
        </DialogHeader>
        <div
          ref={bodyRef}
          tabIndex={-1}
          className="min-h-0 flex-1 overflow-y-auto text-sm leading-relaxed text-foreground/90 focus:outline-none"
        >
          {children}
        </div>
      </DialogContent>
    </Dialog>
  );
};
