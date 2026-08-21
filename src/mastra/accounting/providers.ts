import { fixtureDb, fixtureProvider, screenFixtureVendor } from "./fixture.ts";
import { makeQuickBooksProvider } from "./quickbooks.ts";
import type { AccountingProvider, InvoiceHistory, SanctionsScreener } from "./types.ts";
import type { PolicyConfig, PriorInvoice } from "../invoice/schema.ts";

class InMemoryInvoiceHistory implements InvoiceHistory {
  private readonly invoices = new Map<string, PriorInvoice>();

  async findPotentialDuplicates(input: {
    vendorId: string;
    invoiceNumber: string;
    currency: string;
    totalMinor: number;
  }) {
    const invoiceNumber = input.invoiceNumber.trim().toLowerCase();
    return [...this.invoices.values()].filter(
      (invoice) =>
        invoice.vendorId === input.vendorId &&
        (invoice.invoiceNumber?.trim().toLowerCase() === invoiceNumber ||
          (invoice.currency === input.currency && invoice.totalMinor === input.totalMinor)),
    );
  }

  async seed(invoices: PriorInvoice[]) {
    for (const invoice of invoices) this.invoices.set(invoice.id, invoice);
  }

  async save(invoice: PriorInvoice) {
    this.invoices.set(invoice.id, invoice);
  }
}

const loadProvider = () => {
  const id = process.env.ACCOUNTING_PROVIDER?.trim() || "fixture";
  if (id === "fixture") return fixtureProvider;
  if (id === "quickbooks-mcp") return makeQuickBooksProvider();
  throw new Error(`Unknown accounting provider: ${id}`);
};

export interface InvoiceRuntime {
  provider: AccountingProvider;
  history: InvoiceHistory;
  policy: PolicyConfig;
  screenVendor: SanctionsScreener;
  sanctionsSource: string;
  seedHistory(): Promise<void>;
}

function createInvoiceRuntime(provider = loadProvider()): InvoiceRuntime {
  const fixtureSanctions = process.env.SANCTIONS_SCREENING === "fixture";
  const screenVendor = provider.screenVendor ?? (fixtureSanctions ? screenFixtureVendor : null);
  if (!screenVendor) throw new Error(`${provider.displayName} requires a sanctions screener`);

  const history = new InMemoryInvoiceHistory();
  let historySeed: Promise<void> | undefined;

  return {
    provider,
    history,
    policy: fixtureDb.policy,
    screenVendor,
    sanctionsSource: provider.screenVendor ? provider.id : "fixture-sanctions",
    async seedHistory() {
      if (!provider.listBills) return Promise.resolve();
      try {
        return await (historySeed ??= provider
          .listBills()
          .then((invoices) => history.seed(invoices)));
      } catch (error) {
        historySeed = undefined;
        throw error;
      }
    },
  };
}

export const activeInvoiceRuntime = createInvoiceRuntime();
