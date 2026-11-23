import { ChevronDownIcon } from "lucide-react";
import type { Tier } from "@/backend/types.ts";
import { Badge } from "@/components/ui/badge";

const TIER_STYLE: Record<Tier, string> = {
  communicator: "border-primary/50 text-primary",
  builder: "border-transparent bg-secondary text-secondary-foreground",
  grunt: "text-muted-foreground border-border",
};

/** Which tier runs a job, louder the more capable (and scarce) it is. The one way a tier shows anywhere. */
export function TierBadge({ tier, more }: { tier: Tier; more?: boolean }) {
  return (
    <Badge variant="outline" className={TIER_STYLE[tier]}>
      {tier}
      {more && <ChevronDownIcon data-icon="inline-end" />}
    </Badge>
  );
}
