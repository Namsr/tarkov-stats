import { requireAxisKdaEditor } from "@/lib/axis-access";
import { updateAxisProfile } from "@/lib/axis-profile-mutation";

export const runtime = "nodejs";
export async function POST(request: Request) {
  return updateAxisProfile(request, requireAxisKdaEditor);
}
