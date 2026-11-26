import path from 'node:path';
import { powershellArgs, runChild } from '../lifecycle/childProcesses';

export function powershellPath(): string {
  const root = process.env['SystemRoot'] ?? 'C:\\Windows';
  return path.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}

/** Run a read-only script in a hidden PowerShell and return what it printed. Rejects on timeout or failure. */
export async function runPowerShell(script: string, options: { timeoutMs?: number; env?: Record<string, string> } = {}): Promise<string> {
  try {
    const { stdout } = await runChild(powershellPath(), powershellArgs(script), { timeoutMs: options.timeoutMs ?? 20_000, maxBuffer: 4 * 1024 * 1024, ...(options.env ? { env: options.env } : {}) });
    return stdout;
  } catch (error) {
    throw new Error((error instanceof Error ? error.message : String(error)).split('\n')[0] ?? 'PowerShell failed', { cause: error });
  }
}
