import {
  type CommandBarLock,
  lockLabel,
  lockTokens,
} from "./JobCommandBar.utils";
import { TokenBadge } from "./JobStatusBadge";

interface JobCommandBarLockBadgeProps {
  activeLock: CommandBarLock;
}

export const JobCommandBarLockBadge = ({
  activeLock,
}: JobCommandBarLockBadgeProps) => (
  <TokenBadge
    tone={lockTokens[activeLock]}
    label={`@${lockLabel[activeLock]}`}
  />
);
