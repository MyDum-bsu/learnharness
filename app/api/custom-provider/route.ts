/** PR #62's single custom endpoint: discover/manual connect, offline pins,
 * and disconnect. Host boundaries and mutations live behind the server barrel. */
import { announceSettingsChanged, customProviderGet, customProviderMutation } from "@/src/server";
import { mobileRefusal } from "@/src/server/mobile-api.ts";

export const dynamic = "force-dynamic";
export const GET = customProviderGet;
/** A saved custom provider changes every device's model catalog. */
async function mutation(request: Request): Promise<Response> {
	// Provider credentials and endpoints are owner territory (mobile-api wave).
	const refusal = mobileRefusal(request.headers, "change the custom provider");
	if (refusal) return refusal;
	const response = await customProviderMutation(request);
	if (response.ok) announceSettingsChanged("keys");
	return response;
}

export const POST = mutation;
export const PATCH = mutation;
export const DELETE = mutation;
