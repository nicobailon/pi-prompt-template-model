import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { PromptLoaderDiagnostic } from "./prompt-loader.ts";

export function notify(
	ctx: Pick<ExtensionContext, "hasUI" | "ui"> | undefined,
	message: string,
	type: "info" | "warning" | "error" = "info",
) {
	if (ctx?.hasUI) {
		ctx.ui.notify(message, type);
		return;
	}

	process.stderr.write(`${message}\n`);
}

export function summarizePromptDiagnostics(diagnostics: PromptLoaderDiagnostic[]): string | undefined {
	if (diagnostics.length === 0) return undefined;

	const lines = diagnostics.slice(0, 4).map((diagnostic) => `- ${diagnostic.message}`);
	const remaining = diagnostics.length - lines.length;
	if (remaining > 0) {
		lines.push(`- ... and ${remaining} more prompt template issue(s)`);
	}

	return [`[pi-prompt-template-model] Found ${diagnostics.length} prompt template issue(s):`, ...lines].join("\n");
}

export function diagnosticsFingerprint(diagnostics: PromptLoaderDiagnostic[]): string {
	return diagnostics.map((diagnostic) => diagnostic.key).sort().join("\n");
}
