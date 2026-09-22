/** Display the current working directory in the footer. */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
	pi.on("session_start", async (_event, ctx) => {
		ctx.ui.setStatus("current-folder", "💻 " + ctx.cwd + "\\>");
	});
}
