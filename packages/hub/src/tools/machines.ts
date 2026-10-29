import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Gateway } from "../gateway.js";
import type { Store, User } from "../store.js";

export interface MachineSummary {
  id: string;
  name: string;
  online: boolean;
  /** The owner's display login. */
  owner: string;
  /** True when the caller does not own the machine. */
  shared: boolean;
}

/** Machines the user owns or that were shared with them; nothing else. */
export function listMachines(store: Store, gateway: Gateway, user: User): MachineSummary[] {
  const owners = new Map<string, string>();
  const ownerLogin = (ownerId: string) => {
    if (!owners.has(ownerId)) owners.set(ownerId, store.getUser(ownerId)?.login ?? "");
    return owners.get(ownerId)!;
  };
  return store.machinesFor(user.id).map((m) => ({
    id: m.id,
    name: m.name,
    online: gateway.isOnline(m.id),
    owner: ownerLogin(m.ownerId),
    shared: m.ownerId !== user.id,
  }));
}

const MachineSummarySchema = z.object({
  id: z.string(),
  name: z.string(),
  online: z.boolean(),
  owner: z.string(),
  shared: z.boolean(),
});

export function registerMachineTools(server: McpServer, store: Store, gateway: Gateway, user: User): void {
  server.registerTool(
    "list_machines",
    {
      description: "List the machines you can use (your own and those shared with you) and whether each is online.",
      outputSchema: { machines: z.array(MachineSummarySchema) },
    },
    async () => {
      const machines = listMachines(store, gateway, user);
      return {
        content: [{ type: "text", text: JSON.stringify(machines) }],
        structuredContent: { machines },
      };
    },
  );
}
