import { audit } from "../audit";
import type { Context } from "../context";
import { json } from "../http";
import { verifyInstanceRequest } from "../verify";

export async function handleUnlink(ctx: Context, request: Request, body: Uint8Array): Promise<Response> {
  const verified = await verifyInstanceRequest(ctx, request, "/unlink", body, "unlink_rejected");
  if (verified instanceof Response) return verified;
  const { instance } = verified;
  await ctx.store.deleteInstance(instance.instanceId);
  audit(ctx.log, "unlink", {
    outcome: "ok",
    instance_id: instance.instanceId,
    github_user_id: instance.githubUserId,
    ray: ctx.ray,
  });
  return json(200, { unlinked: true, instance_id: instance.instanceId });
}
