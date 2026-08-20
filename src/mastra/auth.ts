import { RequestContext } from "@mastra/core/request-context";
import { SimpleAuth } from "@mastra/core/server";

export type ApUser = { id: string; name: string; role: "ap_approver" | "viewer" };
const configuredToken = process.env.MASTRA_AUTH_TOKEN?.trim(),
  configuredUserId = process.env.MASTRA_AUTH_USER_ID?.trim();
if (
  process.env.NODE_ENV === "production" &&
  (!configuredToken || !configuredUserId || configuredToken === "local-development-token")
)
  throw new Error(
    "Non-default MASTRA_AUTH_TOKEN and MASTRA_AUTH_USER_ID are required in production",
  );

export const apAuth = new SimpleAuth<ApUser>({
  tokens: {
    [configuredToken || "local-development-token"]: {
      id: configuredUserId || "local-reviewer",
      name: configuredUserId || "Local reviewer",
      role: "ap_approver",
    },
  },
  protected: ["/api/*"],
});
export function setAuthenticatedReviewer(requestContext: RequestContext<any>, user: ApUser | null) {
  requestContext.delete("reviewerId");
  if (user?.role === "ap_approver") requestContext.set("reviewerId", user.id);
}
