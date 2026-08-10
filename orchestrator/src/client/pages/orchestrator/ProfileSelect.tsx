import type { Profile } from "@shared/types";
import { ChevronDown } from "lucide-react";
import type React from "react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

interface ProfileSelectProps {
  profiles: Profile[];
  selectedProfileIds: string[];
  onToggle: (id: string) => void;
  disabled?: boolean;
}

/**
 * Header dropdown that picks which Profiles a run uses. Ticking more than one
 * makes the run sequential — one profile after another. Presentational: the
 * query, selection state, and set-default mutation live in `useSelectedProfile`.
 */
export const ProfileSelect: React.FC<ProfileSelectProps> = ({
  profiles,
  selectedProfileIds,
  onToggle,
  disabled,
}) => {
  if (profiles.length === 0) return null;

  const selected = profiles.filter((profile) =>
    selectedProfileIds.includes(profile.id),
  );
  const label =
    selected.length === 0
      ? "Profile"
      : selected.length === 1
        ? (selected[0]?.name ?? "Profile")
        : `${selected.length} profiles`;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild disabled={disabled}>
        <Button
          type="button"
          variant="outline"
          className="h-8 w-[10rem] justify-between font-normal"
          aria-label="Active profiles"
        >
          <span className="truncate">{label}</span>
          <ChevronDown className="h-4 w-4 shrink-0 opacity-50" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-[14rem]">
        {profiles.map((profile) => {
          const checked = selectedProfileIds.includes(profile.id);
          return (
            <DropdownMenuCheckboxItem
              key={profile.id}
              checked={checked}
              // Radix closes the menu on select; without this the user can only
              // ever toggle one profile per open.
              onSelect={(event) => event.preventDefault()}
              onCheckedChange={() => onToggle(profile.id)}
            >
              <span className="truncate">{profile.name}</span>
            </DropdownMenuCheckboxItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
};
