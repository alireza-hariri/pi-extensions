import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { debug, getBaseUrl, routeUsesVpn } from "./shared/lib.ts";

const PROVIDER = "openrouter";

export default function (pi: ExtensionAPI) {
  let lastMode: "vpn" | "direct" | "error" | undefined;

  pi.on("input", async (event, ctx) => {
    if (event.source === "extension") return { action: "continue" as const };

    // Keep the route check here for a visual status message. getBaseUrl still
    // owns the endpoint selection used by all providers.
    const baseUrl = await getBaseUrl(PROVIDER) 
    pi.registerProvider(PROVIDER, { baseUrl });
      
      
    const { vpn, dev } = await routeUsesVpn();
    debug(ctx,baseUrl)
    ctx.ui.notify(
      vpn
        ? `VPN detected (${dev});`
        : `No VPN detected (${dev});`,
      "info",
    );
    
    return { action: "continue" as const };
  });
}
