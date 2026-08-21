import type { SanctionsScreener } from "./types.ts";
import {
  FixturePolicyProvider,
  FixtureSanctionsScreener,
  InMemoryInvoiceHistoryRepository,
  fixtureProvider,
} from "./fixture.ts";
import { makeQuickBooksMcpProvider } from "./quickbooks.ts";
import {
  assertCapabilityPolicy,
  assertProvider,
  defaultCapabilityPolicy,
  sourceId,
  type AccountingProvider,
  type BooleanCapability,
  type CapabilityPolicy,
  type InvoiceHistoryRepository,
  type PolicyProvider,
  type VendorStatusRestrictionSource,
} from "./types.ts";

const factories: Record<string, () => AccountingProvider> = {
  fixture: () => fixtureProvider,
  "quickbooks-mcp": () => makeQuickBooksMcpProvider(),
};
const instances = new Map<string, AccountingProvider>();

export const providerRegistry = {
  create(id: string) {
    const instance = instances.get(id);
    if (instance) return instance;

    const factory = factories[id];
    if (!factory) throw new Error(`Unknown accounting provider: ${id}`);

    const created = assertProvider(factory());
    instances.set(id, created);
    return created;
  },
};

export function validateProviderSelection(
  provider: AccountingProvider,
  options: { policy?: CapabilityPolicy; sanctionsFallback?: SanctionsScreener } = {},
) {
  const policy = options.policy ?? defaultCapabilityPolicy;
  assertCapabilityPolicy(policy);
  const missing = policy.required.filter(
    (capability) =>
      !provider.capabilities[capability] &&
      !(capability === "sanctions" && options.sanctionsFallback),
  );
  if (missing.length)
    throw new Error(
      `Accounting provider ${provider.id} is missing required capabilities: ${missing.join(", ")}`,
    );
  return provider;
}
export const missingCapabilities = (
  provider: AccountingProvider,
  capabilities: BooleanCapability[],
) => capabilities.filter((capability) => !provider.capabilities[capability]);

export interface InvoiceRuntime {
  provider: AccountingProvider;
  history: InvoiceHistoryRepository;
  policy: PolicyProvider;
  sanctions: SanctionsScreener;
  sanctionsIsFallback: boolean;
  statusRestrictions?: VendorStatusRestrictionSource;
  seedHistory(): Promise<void>;
}
export function createInvoiceRuntime(
  options: {
    provider?: AccountingProvider;
    providerId?: string;
    history?: InvoiceHistoryRepository;
    policy?: PolicyProvider;
    sanctionsFallback?: SanctionsScreener;
    statusRestrictions?: VendorStatusRestrictionSource;
  } = {},
): InvoiceRuntime {
  const provider =
    options.provider ??
    providerRegistry.create(options.providerId ?? process.env.ACCOUNTING_PROVIDER ?? "fixture");
  const fallback =
    options.sanctionsFallback ??
    (process.env.SANCTIONS_SCREENING === "fixture" ? new FixtureSanctionsScreener() : undefined);
  validateProviderSelection(provider, { sanctionsFallback: fallback });
  const sanctions = provider.sanctions ?? fallback;
  if (!sanctions)
    throw new Error(`Accounting provider ${provider.id} requires a sanctions screener`);
  const history = options.history ?? new InMemoryInvoiceHistoryRepository(),
    policy = options.policy ?? new FixturePolicyProvider();
  let syncing: Promise<void> | undefined;
  return {
    provider,
    history,
    policy,
    sanctions,
    sanctionsIsFallback: !provider.sanctions,
    statusRestrictions: options.statusRestrictions,
    seedHistory: () => {
      if (!provider.billHistorySeed) return Promise.resolve();
      if (!syncing)
        syncing = provider
          .billHistorySeed()
          .then((invoices) => history.seed(invoices))
          .catch((error) => {
            syncing = undefined;
            throw error;
          });
      return syncing;
    },
  };
}
export const activeInvoiceRuntime = createInvoiceRuntime();
export const runtimeSources = (runtime: InvoiceRuntime) => ({
  vendors: sourceId(runtime.provider, "vendors"),
  purchaseOrders: sourceId(runtime.provider, "purchaseOrders"),
  goodsReceipts: sourceId(runtime.provider, "goodsReceipts"),
  sanctions: runtime.sanctionsIsFallback
    ? "standalone-sanctions"
    : sourceId(runtime.provider, "sanctions"),
  billHistory: runtime.provider.billHistorySeed
    ? sourceId(runtime.provider, "billHistory")
    : "pipeline-history",
});
