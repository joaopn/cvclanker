import { Plus, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  type ActiveFacet,
  FACET_DEFS,
  FACET_DEFS_BY_ID,
} from "./facets/registry";

interface FacetBarProps {
  activeFacets: ActiveFacet[];
  onAddFacet: (id: string) => void;
  onRemoveFacet: (id: string) => void;
  onSetFacetValue: (id: string, value: string) => void;
  onClearFacets: () => void;
}

export function FacetBar({
  activeFacets,
  onAddFacet,
  onRemoveFacet,
  onSetFacetValue,
  onClearFacets,
}: FacetBarProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!menuOpen) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) {
        setMenuOpen(false);
      }
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [menuOpen]);

  const activeIds = new Set(activeFacets.map((facet) => facet.id));
  const addable = FACET_DEFS.filter((def) => !activeIds.has(def.id));

  return (
    <div className="flex flex-wrap items-center gap-2">
      {activeFacets.map((facet) => {
        const def = FACET_DEFS_BY_ID[facet.id];
        if (!def) return null;
        return (
          <div
            key={facet.id}
            className="flex items-center gap-1 rounded-md border border-border/60 bg-muted/20 py-0.5 pl-2 pr-0.5"
          >
            <span className="text-xs font-medium text-muted-foreground">
              {def.label}
            </span>
            <Input
              value={facet.value}
              onChange={(event) =>
                onSetFacetValue(facet.id, event.target.value)
              }
              placeholder={def.placeholder}
              aria-label={`${def.label} filter`}
              className="h-6 w-36 border-0 bg-transparent px-1 text-xs shadow-none focus-visible:ring-0"
            />
            <Button
              type="button"
              size="icon"
              variant="ghost"
              className="h-6 w-6 shrink-0 text-muted-foreground hover:text-foreground"
              aria-label={`Remove ${def.label} filter`}
              onClick={() => onRemoveFacet(facet.id)}
            >
              <X />
            </Button>
          </div>
        );
      })}

      <div className="relative" ref={menuRef}>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          className="h-7 px-2 text-xs text-muted-foreground hover:text-foreground"
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          disabled={addable.length === 0}
          onClick={() => setMenuOpen((open) => !open)}
        >
          <Plus />
          Filter
        </Button>
        {menuOpen && addable.length > 0 ? (
          <div
            role="menu"
            className="absolute left-0 top-full z-20 mt-1 min-w-40 rounded-md border border-border bg-popover p-1 shadow-md"
          >
            {addable.map((def) => (
              <button
                key={def.id}
                type="button"
                role="menuitem"
                className="flex w-full items-center rounded-sm px-2 py-1.5 text-left text-xs hover:bg-muted"
                onClick={() => {
                  onAddFacet(def.id);
                  setMenuOpen(false);
                }}
              >
                {def.label}
              </button>
            ))}
          </div>
        ) : null}
      </div>

      {activeFacets.length > 0 ? (
        <Button
          type="button"
          size="sm"
          variant="ghost"
          className="h-7 px-2 text-xs text-muted-foreground hover:text-foreground"
          onClick={onClearFacets}
        >
          Clear
        </Button>
      ) : null}
    </div>
  );
}
