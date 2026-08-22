import { RequestContext } from "@mastra/core/request-context";
import { SimpleAuth } from "@mastra/core/server";
import type { ReviewerContext } from "./invoice/schema.ts";

type ApUser = { id: string; name: string; role: "ap_approver" | "viewer" };
const configuredToken = process.env.MASTRA_AUTH_TOKEN?.trim(),
  configuredUserId = process.env.MASTRA_AUTH_USER_ID?.trim();

export const serverHost = process.env.MASTRA_HOST?.trim() || "127.0.0.1";

export const authConfigurationError =
  Boolean(configuredToken) !== Boolean(configuredUserId)
    ? "Set both MASTRA_AUTH_TOKEN and MASTRA_AUTH_USER_ID, or leave both unset"
    : undefined;

export const apAuth =
  configuredToken && configuredUserId
    ? new SimpleAuth<ApUser>({
        tokens: {
          [configuredToken]: {
            id: configuredUserId,
            name: configuredUserId,
            role: "ap_approver",
          },
        },
        protected: ["/api/*"],
      })
    : undefined;

export async function getCurrentApUser(request: Request): Promise<ApUser | null> {
  return apAuth ? apAuth.getCurrentUser(request) : null;
}

export function setAuthenticatedReviewer(
  requestContext: RequestContext<ReviewerContext>,
  user: ApUser | null,
) {
  requestContext.delete("reviewerId");
  if (user?.role === "ap_approver") requestContext.set("reviewerId", user.id);
}
