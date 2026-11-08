import type { Config } from "../config.ts";
import { AirwallexProvider } from "./airwallex.ts";
import { TestPaymentProvider } from "./test-provider.ts";
import type { PaymentProvider, ProviderName } from "./types.ts";

export * from "./types.ts";
export { TestPaymentProvider } from "./test-provider.ts";

export type PaymentProviders = Map<ProviderName, PaymentProvider>;

export function createProviders(config: Config): PaymentProviders {
  const providers: PaymentProviders = new Map();
  const p = config.payments;
  if (p.airwallex) providers.set("airwallex", new AirwallexProvider(p.airwallex));
  if (p.testProvider) providers.set("test", new TestPaymentProvider(p.testProvider.webhookSecret, p.appUrl));
  return providers;
}
