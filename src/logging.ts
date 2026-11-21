import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export function appendBridgeLog(path: string, line: string): boolean {
	try {
		mkdirSync(dirname(path), { recursive: true });
		appendFileSync(path, line, { mode: 0o600 });
		return true;
	} catch {
		return false;
	}
}
