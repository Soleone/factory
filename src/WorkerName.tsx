import { cn } from "cn";
import type { ComponentType } from "react";
import { poolOf, type Preset } from "@/backend/types.ts";
import { ClaudeLogo, OpenAILogo } from "@/components/soleone/usage-ring/logos";
import { useModels } from "@/RunFields";

type Provider = { name: string; Logo?: ComponentType<{ className?: string }> };

const CLAUDE = ({ className }: { className?: string }) => (
  <ClaudeLogo className={cn("text-claude", className)} />
);
// OpenAI's mark is monochrome, so it takes the theme's ink, as on the usage rings.
const PROVIDERS: Record<string, Provider> = {
  claude: { name: "Claude", Logo: CLAUDE },
  // Pi's API-key providers, billed apart from the subscriptions.
  anthropic: { name: "Anthropic API", Logo: CLAUDE },
  openai: { name: "OpenAI API", Logo: OpenAILogo },
  "openai-codex": { name: "OpenAI", Logo: OpenAILogo },
};

/** Who a pool's usage counts against, as people know it: Claude or OpenAI, not openai-codex. */
export const providerOf = (pool: string): Provider => PROVIDERS[pool] ?? { name: pool };

export function ProviderLogo({ pool }: { pool: string }) {
  const { Logo } = providerOf(pool);
  return Logo ? <Logo className="size-3.5 shrink-0" /> : null;
}

/** A preset's model as its agent names it, like Opus 5.5, for places that take plain text. */
export function useModelLabel(): (of: Preset) => string {
  const models = useModels();
  return (of) =>
    models[of.agent]?.find((model) => model.value === of.model)?.label ??
    of.model ??
    `${providerOf(poolOf(of)).name} default`;
}

/**
 * How a worker reads wherever it's shown rather than edited: its provider's logo, its model and,
 * muted, its effort. Under a provider's heading the logo is left out.
 */
export function WorkerName({ of, logo = true }: { of: Preset; logo?: boolean }) {
  const label = useModelLabel()(of);
  return (
    <span className="inline-flex min-w-0 items-center gap-1.5">
      {logo && <ProviderLogo pool={poolOf(of)} />}
      <span className="truncate">
        {label}
        {of.effort && <span className="text-muted-foreground"> · {of.effort}</span>}
      </span>
    </span>
  );
}
