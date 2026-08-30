/**
 * Swipe deck card. `SwipeCardContent` is the static visual (reused for the
 * peek of the next card underneath). `SwipeCard` wraps it with the drag
 * gesture and a short fly-off animation on commit — drag past the threshold,
 * or call `flyOut(action)` imperatively from the action-bar buttons.
 */

import { FitAssessment } from "@client/components/FitAssessment";
import { FitIndicator } from "@client/components/ScoreIndicator";
import { JobDescriptionMarkdown } from "@client/components/JobDescriptionMarkdown";
import type { Job } from "@shared/types.js";
import {
  type PanInfo,
  animate,
  motion,
  useMotionValue,
  useTransform,
} from "framer-motion";
import { Building2, MapPin, Users, Wallet } from "lucide-react";
import { forwardRef, useImperativeHandle } from "react";
import type React from "react";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import { Card } from "@/components/ui/card";
import { LIVE_CLOSED_CHIP_CLASS } from "../orchestrator/constants";
import { dateValue, formatCheckedAge } from "../orchestrator/utils";
import type { SwipeAction } from "./useSwipeDeck";

const COMMIT_OFFSET = 110; // px past which a release commits the swipe
const COMMIT_VELOCITY = 500; // px/s flick that commits regardless of offset
const FLY_DURATION = 0.24; // seconds for the card to leave the screen
const DAY_MS = 24 * 60 * 60 * 1000;

// "Posted Nd" when the source supplied a posting date, else "Found Nd".
const formatAge = (job: Job): string | null => {
  const now = Date.now();
  const posted = dateValue(job.datePosted);
  if (posted != null)
    return `Posted ${Math.max(0, Math.floor((now - posted) / DAY_MS))}d`;
  const found = dateValue(job.discoveredAt);
  if (found != null)
    return `Found ${Math.max(0, Math.floor((now - found) / DAY_MS))}d`;
  return null;
};

export const SwipeCardContent: React.FC<{ job: Job }> = ({ job }) => {
  const age = formatAge(job);
  return (
    <Card className="flex h-full flex-col overflow-hidden">
      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-5 [touch-action:pan-y]">
        <div className="space-y-1 text-center">
          <h2 className="text-xl font-semibold leading-tight">{job.title}</h2>
          <p className="flex items-center justify-center gap-1.5 text-sm text-muted-foreground">
            <Building2 className="h-3.5 w-3.5" />
            {job.employer}
          </p>
        </div>

        <div className="flex flex-col items-center gap-1.5 text-xs text-muted-foreground">
          {job.location && (
            <span className="flex items-center gap-1">
              <MapPin className="h-3 w-3" />
              {job.location}
            </span>
          )}
          {job.salary && (
            <span className="flex items-center gap-1">
              <Wallet className="h-3 w-3" />
              {job.salary}
            </span>
          )}
        </div>

        {age && (
          <p className="text-center text-xs tabular-nums text-muted-foreground">
            {age}
          </p>
        )}

        {/* Applicant volume, as read from the board by the live-status action.
            Absent on a row nobody has checked — there is no other source for
            it, so the card says nothing rather than guessing. */}
        {job.liveStatusCheckedAt && (
          <div className="flex flex-col items-center gap-1 text-xs text-muted-foreground">
            {job.liveClosed ? (
              <span className={LIVE_CLOSED_CHIP_CLASS}>
                No longer accepting applications
              </span>
            ) : (
              // LinkedIn resets the caption once a posting closes, so the
              // server stores null for it — a caption is an open job's.
              <span className="flex items-center gap-1">
                <Users className="h-3 w-3" />
                {job.liveApplicants ?? "Accepting applications"}
              </span>
            )}
            <span className="text-muted-foreground/70">
              {formatCheckedAge(job.liveStatusCheckedAt, Date.now())}
            </span>
          </div>
        )}

        <div className="flex justify-center">
          <FitIndicator category={job.suitabilityCategory ?? null} />
        </div>

        <FitAssessment job={job} />

        {job.jobDescription && (
          <Accordion type="single" collapsible defaultValue="description">
            <AccordionItem value="description" className="border-b-0">
              <AccordionTrigger className="text-sm">
                Job description
              </AccordionTrigger>
              <AccordionContent>
                <JobDescriptionMarkdown description={job.jobDescription} />
              </AccordionContent>
            </AccordionItem>
          </Accordion>
        )}
      </div>
    </Card>
  );
};

export interface SwipeCardHandle {
  flyOut: (action: SwipeAction) => void;
}

interface SwipeCardProps {
  job: Job;
  /** Fired once the fly-off animation completes. */
  onCommit: (action: SwipeAction) => void;
}

export const SwipeCard = forwardRef<SwipeCardHandle, SwipeCardProps>(
  ({ job, onCommit }, ref) => {
    const x = useMotionValue(0);
    const y = useMotionValue(0);
    const rotate = useTransform(x, [-250, 250], [-12, 12]);
    const tailorOpacity = useTransform(x, [20, 130], [0, 1]);
    const skipOpacity = useTransform(x, [-130, -20], [1, 0]);

    const flyOut = (action: SwipeAction) => {
      const distance =
        (typeof window !== "undefined" ? window.innerWidth : 800) * 1.3;
      const opts = {
        duration: FLY_DURATION,
        ease: "easeOut" as const,
        onComplete: () => onCommit(action),
      };
      if (action === "move_to_ready") animate(x, distance, opts);
      else if (action === "skip") animate(x, -distance, opts);
      else animate(y, 700, opts); // backlog: drop the card away
    };

    useImperativeHandle(ref, () => ({ flyOut }));

    const handleDragEnd = (_: unknown, info: PanInfo) => {
      const { offset, velocity } = info;
      if (offset.x > COMMIT_OFFSET || velocity.x > COMMIT_VELOCITY) {
        flyOut("move_to_ready");
      } else if (offset.x < -COMMIT_OFFSET || velocity.x < -COMMIT_VELOCITY) {
        flyOut("skip");
      }
    };

    return (
      <motion.div
        className="absolute inset-0"
        style={{ x, y, rotate, touchAction: "pan-y" }}
        initial={{ scale: 0.97 }}
        animate={{ scale: 1 }}
        transition={{ duration: 0.15 }}
        drag="x"
        dragDirectionLock
        dragConstraints={{ left: 0, right: 0 }}
        dragElastic={1}
        dragMomentum={false}
        onDragEnd={handleDragEnd}
        whileTap={{ cursor: "grabbing" }}
      >
        <SwipeCardContent job={job} />

        <motion.div
          style={{ opacity: tailorOpacity }}
          className="pointer-events-none absolute left-4 top-4 z-10 rotate-[-12deg] rounded-md border-2 border-status-good px-3 py-1 text-lg font-extrabold uppercase tracking-wider text-status-good-text"
        >
          Tailor
        </motion.div>
        <motion.div
          style={{ opacity: skipOpacity }}
          className="pointer-events-none absolute right-4 top-4 z-10 rotate-[12deg] rounded-md border-2 border-status-bad px-3 py-1 text-lg font-extrabold uppercase tracking-wider text-status-bad-text"
        >
          Skip
        </motion.div>
      </motion.div>
    );
  },
);

SwipeCard.displayName = "SwipeCard";
