import { buildNativeWindowRevealScript } from './native-window-reveal';

/** Compatibility entry for the dsh-specific script contract introduced in SPEC-014. */
export function buildDshNativeRevealScript(pid: number, hwnd: number): string {
  return buildNativeWindowRevealScript(pid, hwnd, 'dsh');
}
